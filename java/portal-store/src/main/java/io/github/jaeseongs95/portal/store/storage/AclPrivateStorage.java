package io.github.jaeseongs95.portal.store.storage;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.FileStore;
import java.nio.file.FileSystem;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.attribute.AclEntry;
import java.nio.file.attribute.AclEntryFlag;
import java.nio.file.attribute.AclEntryPermission;
import java.nio.file.attribute.AclEntryType;
import java.nio.file.attribute.AclFileAttributeView;
import java.nio.file.attribute.UserPrincipal;
import java.nio.file.attribute.UserPrincipalNotFoundException;
import java.util.ArrayList;
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
 * {@link PrivateStorage} for a file store with the {@code acl} view (an NTFS volume), where there are no permission bits.
 *
 * <p><b>Making a path private.</b> The access control list of a new folder or file is replaced by two entries: full control for its owner and for the system account
 * ({@link AclFileAttributeView#setAcl}). The entries of a folder are inheritable, so the files that are made in it start private too; every file is also made private
 * explicitly right after it is created. What the volume's parent folder grants (typically {@code Users}) is therefore not inherited by a path of the store. The ACL of a
 * new file is set after it is created, because the owner (the account the process runs as) is known only from the created file; it has no bytes yet at that moment.
 *
 * <p><b>Checking a path.</b> Every {@code ALLOW} entry that gives data access (read, write, append) or the right to change the ACL or the owner to a principal other than
 * the owner, the system account and the Administrators group is refused. {@code DENY} entries are not looked at: they only narrow what an allowed entry gives.
 * Principals are compared as objects ({@link UserPrincipal#equals}), not by their names, which differ between the languages of Windows; the well-known accounts are
 * looked up by their English names and, when a name is not known to the machine, left out (the check then only allows the owner).
 *
 * <p><b>Hard links.</b> A Java program cannot read the link count of an NTFS file ({@code unix:nlink} exists only in the {@code unix} view). The count is not checked
 * here, and that is a documented decision and not a silent omission: a second name for a payload can be made only by a principal who may write a folder, and the
 * folders of the store allow nobody but the owner and the system account (checked by {@link #requireProtected}), so no other principal can make one.
 *
 * <p>Based on the Java SE API: {@code AclFileAttributeView}, {@code AclEntry} and {@code UserPrincipalLookupService}
 * (https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/nio/file/attribute/AclFileAttributeView.html,
 * https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/nio/file/attribute/AclEntry.html,
 * https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/nio/file/attribute/UserPrincipalLookupService.html).
 */
@Component
@Order(2)
public final class AclPrivateStorage implements PrivateStorage {

    private static final Logger LOG = LoggerFactory.getLogger(AclPrivateStorage.class);
    private static final String ACL_VIEW = "acl";
    /** Data access, and the rights with which a principal could give itself data access. */
    private static final Set<AclEntryPermission> DANGEROUS = EnumSet.of(AclEntryPermission.READ_DATA, AclEntryPermission.WRITE_DATA, AclEntryPermission.APPEND_DATA,
        AclEntryPermission.WRITE_ACL, AclEntryPermission.WRITE_OWNER);
    private static final List<String> SYSTEM_NAMES = List.of("NT AUTHORITY\\SYSTEM", "SYSTEM");
    private static final List<String> ADMINISTRATORS_NAMES = List.of("BUILTIN\\Administrators", "Administrators");

    @Override
    public boolean supports(FileStore store) {
        return store.supportsFileAttributeView(ACL_VIEW);
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
    public FileChannel open(Path file, Set<? extends OpenOption> options) throws IOException {
        boolean existed = Files.exists(file, LinkOption.NOFOLLOW_LINKS);
        FileChannel channel = FileChannel.open(file, options);
        if (existed) {
            return channel;
        }
        try {
            protect(file, false);
        } catch (IOException | RuntimeException e) {
            try {
                channel.close();
                Files.deleteIfExists(file);
            } catch (IOException cleanup) {
                e.addSuppressed(cleanup);
            }
            throw e;
        }
        return channel;
    }

    @Override
    public void requireProtected(Path path) throws IOException {
        AclFileAttributeView view = view(path);
        Set<UserPrincipal> allowed = new HashSet<>();
        allowed.add(view.getOwner());
        FileSystem system = path.getFileSystem();
        firstKnown(system, SYSTEM_NAMES).ifPresent(allowed::add);
        firstKnown(system, ADMINISTRATORS_NAMES).ifPresent(allowed::add);
        for (AclEntry entry : view.getAcl()) {
            if (entry.type() == AclEntryType.ALLOW && !Collections.disjoint(entry.permissions(), DANGEROUS) && !allowed.contains(entry.principal())) {
                throw new UnsafeStorageException(path.toString(), "the access control list allows " + entry.principal().getName());
            }
        }
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

    private AclFileAttributeView view(Path path) {
        AclFileAttributeView view = Files.getFileAttributeView(path, AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
        if (view == null) {
            throw new UnsafeStorageException(path.toString(), "the file store has no access control list view");
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
