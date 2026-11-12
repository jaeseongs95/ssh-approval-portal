package io.github.jaeseongs95.portal.store;

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

import io.github.jaeseongs95.portal.store.storage.AclPrivateStorage;
import io.github.jaeseongs95.portal.store.storage.PosixPrivateStorage;
import io.github.jaeseongs95.portal.store.storage.PrivateStorages;

/**
 * What the file tests of the store need to stand in for the product's wiring: the {@link PrivateStorages} with both rules, and a way to make a folder that JUnit created
 * (and that inherits the rights of the system's temporary folder, which others may use) private to its owner the way the product makes its own folders. The product refuses a
 * root folder that others can use; a test that hands such a folder to a store makes it private first.
 */
public final class TestStorage {

    private TestStorage() {
    }

    /** Both rules, in the order of the product ({@code @Order}): permission bits first. */
    public static PrivateStorages rules() {
        return new PrivateStorages(List.of(new PosixPrivateStorage(), new AclPrivateStorage()));
    }

    /**
     * A principal that the product must not let in, looked up by the names of the well-known groups that every Windows has ({@code Everyone}, then the Users group).
     * Fails the test when the machine knows none of them, so the access control list tests never pass by not running.
     */
    public static UserPrincipal outsider(Path anyPath) throws IOException {
        UserPrincipalLookupService lookup = anyPath.getFileSystem().getUserPrincipalLookupService();
        for (String name : List.of("Everyone", "BUILTIN\\Users", "Users", "Authenticated Users")) {
            try {
                return lookup.lookupPrincipalByName(name);
            } catch (UserPrincipalNotFoundException e) {
                // The next well-known name; the loop ends with a failure when none is known.
                continue;
            }
        }
        throw new IllegalStateException("The machine knows none of the well-known groups Everyone, Users, Authenticated Users");
    }

    /** Lets everybody read the folder or the file: group and others bits on a posix store, an ALLOW entry for {@link #outsider} on an acl store. */
    public static void openUp(Path path) throws IOException {
        FileStore store = Files.getFileStore(path);
        if (store.supportsFileAttributeView("posix")) {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(Files.isDirectory(path) ? "rwxr-xr-x" : "rw-r--r--"));
        } else if (store.supportsFileAttributeView("acl")) {
            AclFileAttributeView view = Files.getFileAttributeView(path, AclFileAttributeView.class);
            List<AclEntry> acl = new ArrayList<>(view.getAcl());
            acl.add(0, AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(outsider(path)).setPermissions(AclEntryPermission.READ_DATA,
                AclEntryPermission.READ_ATTRIBUTES, AclEntryPermission.READ_ACL, AclEntryPermission.SYNCHRONIZE).build());
            view.setAcl(acl);
        } else {
            throw new IllegalStateException("The file store has neither the posix nor the acl view");
        }
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
}
