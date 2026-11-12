package io.github.jaeseongs95.portal.ssh.profile;

import java.io.IOException;
import java.nio.file.FileStore;
import java.nio.file.FileSystem;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.AclEntry;
import java.nio.file.attribute.AclEntryFlag;
import java.nio.file.attribute.AclEntryPermission;
import java.nio.file.attribute.AclEntryType;
import java.nio.file.attribute.AclFileAttributeView;
import java.nio.file.attribute.UserPrincipal;
import java.nio.file.attribute.UserPrincipalNotFoundException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * {@link FileAccessRule} for a file store with the {@code acl} view (an NTFS volume), where there are no permission bits. The access control list is read with
 * {@link AclFileAttributeView}; no program is run (2.x PF-05 called {@code icacls.exe}).
 *
 * <p><b>Judging.</b> Only {@code ALLOW} entries count ({@code DENY} entries only narrow what an allowed entry gives). An entry for a principal other than the owner, the
 * system account and the Administrators group is looked at: if it gives the right to write, append, delete, or change the ACL or the owner, the path is refused; if it only
 * gives read access, the verdict for {@link Protection#NO_OTHER_ACCESS} is a warning ({@link AccessVerdict.Exposed}), as in 2.x ({@code waived}, vendor
 * config/windows-acl.js:453-463), and for {@link Protection#NO_OTHER_WRITE} it is fine. Principals are compared as objects ({@link UserPrincipal#equals}), not by name:
 * the names of the well-known accounts differ between the languages of Windows, so they are looked up by their English names and a name the machine does not know
 * is left out (the check then trusts the owner only).
 *
 * <p><b>Making a path private.</b> The list of a new folder or file is replaced by full control for the owner and for the system account; the entries of a folder are
 * inheritable.
 *
 * <p>Based on the Java SE API: {@code AclFileAttributeView}, {@code AclEntry}
 * (https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/nio/file/attribute/AclFileAttributeView.html).
 */
@Component
@Order(2)
public final class AclFileAccessRule implements FileAccessRule {

    private static final Logger LOG = LoggerFactory.getLogger(AclFileAccessRule.class);
    private static final String ACL_VIEW = "acl";
    private static final Set<AclEntryPermission> CHANGES = EnumSet.of(AclEntryPermission.WRITE_DATA, AclEntryPermission.APPEND_DATA, AclEntryPermission.DELETE,
        AclEntryPermission.DELETE_CHILD, AclEntryPermission.WRITE_ACL, AclEntryPermission.WRITE_OWNER);
    private static final List<String> SYSTEM_NAMES = List.of("NT AUTHORITY\\SYSTEM", "SYSTEM");
    private static final List<String> ADMINISTRATORS_NAMES = List.of("BUILTIN\\Administrators", "Administrators");

    @Override
    public boolean supports(FileStore store) {
        return store.supportsFileAttributeView(ACL_VIEW);
    }

    @Override
    public AccessVerdict inspect(Path path, Protection protection) throws IOException {
        AclFileAttributeView view = view(path);
        Set<UserPrincipal> trusted = new HashSet<>();
        trusted.add(view.getOwner());
        FileSystem system = path.getFileSystem();
        firstKnown(system, SYSTEM_NAMES).ifPresent(trusted::add);
        firstKnown(system, ADMINISTRATORS_NAMES).ifPresent(trusted::add);
        return judge(path, trusted, view.getAcl(), protection);
    }

    /** The verdict for the entries of a list: a judgement over values, the part of {@link #inspect} that needs no file system. */
    public AccessVerdict judge(Path path, Collection<UserPrincipal> trusted, List<AclEntry> acl, Protection protection) {
        String firstReader = null;
        for (AclEntry entry : acl) {
            if (entry.type() != AclEntryType.ALLOW || trusted.contains(entry.principal())) {
                continue;
            }
            if (!Collections.disjoint(entry.permissions(), CHANGES)) {
                return new AccessVerdict.Refused("Config path " + path + " can be changed by " + entry.principal().getName()
                    + " (access control list). Remove the entry, or make the file and its folder private to your account");
            }
            if (firstReader == null && entry.permissions().contains(AclEntryPermission.READ_DATA)) {
                firstReader = entry.principal().getName();
            }
        }
        if (firstReader != null && protection == Protection.NO_OTHER_ACCESS) {
            return new AccessVerdict.Exposed("Config path " + path + " can be read by " + firstReader + " (access control list)");
        }
        return new AccessVerdict.Private();
    }

    @Override
    public void createFolder(Path folder) throws IOException {
        Path absolute = folder.toAbsolutePath();
        if (Files.exists(absolute, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        Files.createDirectories(absolute);
        protect(absolute, true);
    }

    @Override
    public void createFile(Path file) throws IOException {
        if (Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        Files.createFile(file);
        protect(file, false);
    }

    private void protect(Path path, boolean folder) throws IOException {
        AclFileAttributeView view = view(path);
        List<AclEntry> acl = new ArrayList<>();
        acl.add(fullControl(view.getOwner(), folder));
        firstKnown(path.getFileSystem(), SYSTEM_NAMES).ifPresent(system -> acl.add(fullControl(system, folder)));
        view.setAcl(acl);
    }

    private AclEntry fullControl(UserPrincipal principal, boolean inheritable) {
        AclEntry.Builder entry = AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(principal).setPermissions(EnumSet.allOf(AclEntryPermission.class));
        if (inheritable) {
            entry.setFlags(AclEntryFlag.FILE_INHERIT, AclEntryFlag.DIRECTORY_INHERIT);
        }
        return entry.build();
    }

    private AclFileAttributeView view(Path path) throws IOException {
        AclFileAttributeView view = Files.getFileAttributeView(path, AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
        if (view == null) {
            throw new IOException("The file store of " + path + " has no access control list view");
        }
        return view;
    }

    /** The principal of the first of the names that the machine knows; a name that it does not know is the normal case on a system in another language. */
    private Optional<UserPrincipal> firstKnown(FileSystem system, List<String> names) {
        for (String name : names) {
            try {
                return Optional.of(system.getUserPrincipalLookupService().lookupPrincipalByName(name));
            } catch (UserPrincipalNotFoundException e) {
                LOG.debug("The account {} is not known to this machine", name, e);
            } catch (IOException e) {
                LOG.warn("The account {} could not be looked up", name, e);
            }
        }
        return Optional.empty();
    }
}
