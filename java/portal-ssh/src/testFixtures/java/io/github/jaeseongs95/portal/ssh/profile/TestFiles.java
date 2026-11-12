package io.github.jaeseongs95.portal.ssh.profile;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.FileStore;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.AclEntry;
import java.nio.file.attribute.AclEntryFlag;
import java.nio.file.attribute.AclEntryPermission;
import java.nio.file.attribute.AclEntryType;
import java.nio.file.attribute.AclFileAttributeView;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.file.attribute.UserPrincipal;
import java.nio.file.attribute.UserPrincipalLookupService;
import java.nio.file.attribute.UserPrincipalNotFoundException;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;

/**
 * What the file tests of the profile and host key packages need to stand in for the product's wiring: the {@link FileAccessGuard} with both rules, a folder made private to
 * its owner the way the product makes its own, and a way to open a path to other accounts. Both file store kinds are served by the same calls, so a test runs on a
 * volume with permission bits and on an NTFS volume without a condition (the choice is made by what the file store offers, as in the product).
 */
public final class TestFiles {

    private TestFiles() {
    }

    /** The guard with both rules, in the order of the product. */
    public static FileAccessGuard guard() {
        return new FileAccessGuard(List.of(new PosixFileAccessRule(), new AclFileAccessRule()));
    }

    /** True when the file store of the path has permission bits; false when it has an access control list. */
    public static boolean hasPermissionBits(Path path) throws IOException {
        return Files.getFileStore(path).supportsFileAttributeView("posix");
    }

    /**
     * A principal that the product must not let in, looked up by the names of the well-known groups that every Windows has. Fails the test when the machine knows none
     * of them, so no check passes by not running.
     */
    public static UserPrincipal outsider(Path anyPath) throws IOException {
        UserPrincipalLookupService lookup = anyPath.getFileSystem().getUserPrincipalLookupService();
        IllegalStateException none = new IllegalStateException("The machine knows none of the well-known groups Everyone, Users, Authenticated Users");
        for (String name : List.of("Everyone", "BUILTIN\\Users", "Users", "Authenticated Users")) {
            try {
                return lookup.lookupPrincipalByName(name);
            } catch (UserPrincipalNotFoundException e) {
                none.addSuppressed(e); // the next well-known name; when none is known the failure carries every miss
            }
        }
        throw none;
    }

    /** Lets other accounts read the folder or the file: group and others bits on a posix store, an ALLOW entry for {@link #outsider} on an acl store. */
    public static void openToRead(Path path) throws IOException {
        FileStore store = Files.getFileStore(path);
        if (store.supportsFileAttributeView("posix")) {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(Files.isDirectory(path) ? "rwxr-xr-x" : "rw-r--r--"));
        } else {
            addEntry(path, AclEntryPermission.READ_DATA, AclEntryPermission.READ_ATTRIBUTES, AclEntryPermission.READ_ACL, AclEntryPermission.SYNCHRONIZE);
        }
    }

    /** Lets other accounts write the folder or the file: group and others write bits on a posix store, an ALLOW entry for {@link #outsider} on an acl store. */
    public static void openToWrite(Path path) throws IOException {
        FileStore store = Files.getFileStore(path);
        if (store.supportsFileAttributeView("posix")) {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(Files.isDirectory(path) ? "rwxrwxrwx" : "rw-rw-rw-"));
        } else {
            addEntry(path, AclEntryPermission.WRITE_DATA, AclEntryPermission.APPEND_DATA, AclEntryPermission.READ_DATA, AclEntryPermission.SYNCHRONIZE);
        }
    }

    private static void addEntry(Path path, AclEntryPermission... permissions) throws IOException {
        AclFileAttributeView view = Files.getFileAttributeView(path, AclFileAttributeView.class);
        List<AclEntry> acl = new ArrayList<>(view.getAcl());
        acl.add(0, AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(outsider(path)).setPermissions(permissions).build());
        view.setAcl(acl);
    }

    /** Makes the existing folder private to its owner; what is created in it later inherits that. Returns the folder. */
    public static Path privateFolder(Path folder) {
        try {
            FileStore store = Files.getFileStore(folder);
            if (store.supportsFileAttributeView("posix")) {
                Files.setPosixFilePermissions(folder, PosixFilePermissions.fromString("rwx------"));
            } else if (store.supportsFileAttributeView("acl")) {
                AclFileAttributeView view = Files.getFileAttributeView(folder, AclFileAttributeView.class);
                AclEntry owner = AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(view.getOwner()).setPermissions(EnumSet.allOf(AclEntryPermission.class))
                    .setFlags(AclEntryFlag.FILE_INHERIT, AclEntryFlag.DIRECTORY_INHERIT).build();
                view.setAcl(List.of(owner));
            }
            return folder;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** Makes the existing file private to its owner. Returns the file. */
    public static Path privateFile(Path file) {
        try {
            if (hasPermissionBits(file)) {
                Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"));
            } else {
                AclFileAttributeView view = Files.getFileAttributeView(file, AclFileAttributeView.class);
                view.setAcl(List.of(AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(view.getOwner()).setPermissions(EnumSet.allOf(AclEntryPermission.class))
                    .build()));
            }
            return file;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
