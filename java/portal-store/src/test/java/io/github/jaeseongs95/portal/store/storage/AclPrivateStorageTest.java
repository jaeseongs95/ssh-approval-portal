package io.github.jaeseongs95.portal.store.storage;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.AclEntry;
import java.nio.file.attribute.AclEntryType;
import java.nio.file.attribute.AclFileAttributeView;
import java.nio.file.attribute.UserPrincipal;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import io.github.jaeseongs95.portal.store.TestStorage;

/**
 * S2-DB-10, the protection of the stores on a file store with an access control list (an NTFS volume). The tests change real ACLs of real folders and files, no mock:
 * what Windows does with inherited entries, with the account names and with the entries that are added afterwards is what is asserted. Java SE API:
 * https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/nio/file/attribute/AclFileAttributeView.html
 */
class AclPrivateStorageTest {

    private final AclPrivateStorage rule = new AclPrivateStorage();

    @TempDir
    Path directory;

    @BeforeEach
    void onlyWhereTheFileStoreHasAnAcl() throws IOException {
        Assumptions.assumeTrue(rule.supports(Files.getFileStore(directory)),
            "the file store of the test folder has no acl view (it is a posix store); runs on the Windows CI (Windows CI에서 실행)");
    }

    private AclFileAttributeView view(Path path) {
        return Files.getFileAttributeView(path, AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
    }

    private Set<UserPrincipal> allowedPrincipals(Path path) throws IOException {
        Set<UserPrincipal> allowed = new HashSet<>();
        for (AclEntry entry : view(path).getAcl()) {
            if (entry.type() == AclEntryType.ALLOW) {
                allowed.add(entry.principal());
            }
        }
        return allowed;
    }

    /** The principals that may be in the list of a private path: its owner and the system account. */
    private Set<UserPrincipal> ownerAndSystem(Path path) throws IOException {
        Set<UserPrincipal> expected = new HashSet<>();
        expected.add(view(path).getOwner());
        for (String name : List.of("NT AUTHORITY\\SYSTEM", "SYSTEM")) {
            try {
                expected.add(path.getFileSystem().getUserPrincipalLookupService().lookupPrincipalByName(name));
                break;
            } catch (IOException e) {
                // The account is known under another name on this machine; the next name is tried.
                continue;
            }
        }
        return expected;
    }

    private byte[] read(Path file) throws IOException {
        return Files.readAllBytes(file);
    }

    private void write(Path file, String text) throws IOException {
        try (FileChannel channel = rule.open(file, Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS))) {
            channel.write(ByteBuffer.wrap(text.getBytes(StandardCharsets.UTF_8)));
        }
    }

    @Test
    @DisplayName("S2-DB-10, RC-A-178: a folder made by the rule is private: its list allows the owner and the system account and nobody else, and the check accepts it")
    void aNewFolderIsOwnerOnly() throws IOException {
        Path folder = directory.resolve("private");

        rule.createFolder(folder);

        assertThat(allowedPrincipals(folder)).isNotEmpty().isSubsetOf(ownerAndSystem(folder));
        rule.requireProtected(folder);
        assertThat(allowedPrincipals(folder)).doesNotContain(TestStorage.outsider(folder));
    }

    @Test
    @DisplayName("S2-DB-10: a folder that exists is left as it is by createFolder; the check is what judges it")
    void anExistingFolderIsNotChanged() throws IOException {
        Path existing = Files.createDirectory(directory.resolve("existing"));
        TestStorage.openUp(existing);
        List<AclEntry> before = view(existing).getAcl();

        rule.createFolder(existing);

        assertThat(view(existing).getAcl()).isEqualTo(before);
        assertThatThrownBy(() -> rule.requireProtected(existing)).isInstanceOf(UnsafeStorageException.class);
    }

    @Test
    @DisplayName("S2-DB-10, RC-A-178: a file made by the rule is private even in a folder whose rights let others in; its bytes are written and read by the owner")
    void aNewFileIsOwnerOnlyEvenWhereTheFolderIsOpen() throws IOException {
        Path open = Files.createDirectory(directory.resolve("open"));
        TestStorage.openUp(open);
        Path file = open.resolve("payload.part");

        write(file, "payload");

        assertThat(allowedPrincipals(file)).isNotEmpty().isSubsetOf(ownerAndSystem(file));
        rule.requireProtected(file);
        assertThat(read(file)).isEqualTo("payload".getBytes(StandardCharsets.UTF_8));
    }

    @Test
    @DisplayName("S2-DB-10: what is made in a folder of the rule inherits a private list, so a file made by a plain call is accepted too (the inherited entries are the owner's)")
    void whatIsMadeInAPrivateFolderInheritsItsList() throws IOException {
        Path folder = directory.resolve("inherits");
        rule.createFolder(folder);

        Path child = Files.createFile(folder.resolve("made-by-a-plain-call"));
        Path subfolder = Files.createDirectory(folder.resolve("sub"));

        assertThat(allowedPrincipals(child)).isSubsetOf(ownerAndSystem(child));
        assertThat(allowedPrincipals(subfolder)).isSubsetOf(ownerAndSystem(subfolder));
        rule.requireProtected(child);
        rule.requireProtected(subfolder);
    }

    @Test
    @DisplayName("S2-DB-10, RC-A-179: an entry for Everyone (or Users) on the folder is refused, and the file in it is not touched")
    void anOutsiderOnTheFolderIsRefused() throws IOException {
        Path folder = directory.resolve("shared");
        rule.createFolder(folder);
        Path file = folder.resolve("payload.part");
        write(file, "secret bytes");
        byte[] before = read(file);

        TestStorage.openUp(folder);

        assertThatThrownBy(() -> rule.requireProtected(folder)).isInstanceOf(UnsafeStorageException.class).hasMessageContaining("allows");
        assertThat(read(file)).isEqualTo(before);
        assertThat(Files.exists(file, LinkOption.NOFOLLOW_LINKS)).isTrue();
    }

    @Test
    @DisplayName("S2-DB-10, RC-A-179: an entry for Everyone (or Users) on a file is refused, and its bytes are not touched")
    void anOutsiderOnTheFileIsRefused() throws IOException {
        Path folder = directory.resolve("folder");
        rule.createFolder(folder);
        Path file = folder.resolve("payload.part");
        write(file, "secret bytes");
        byte[] before = read(file);
        rule.requireProtected(file);

        TestStorage.openUp(file);

        assertThatThrownBy(() -> rule.requireProtected(file)).isInstanceOf(UnsafeStorageException.class).hasMessageContaining("allows");
        assertThat(read(file)).isEqualTo(before);
    }

    @Test
    @DisplayName("S2-DB-10: an entry that only denies is not an access: a DENY for Everyone on a private file does not make it unsafe")
    void aDenyEntryIsNotAnAccess() throws IOException {
        Path folder = directory.resolve("deny");
        rule.createFolder(folder);
        Path file = folder.resolve("payload.part");
        write(file, "bytes");
        AclFileAttributeView view = view(file);
        List<AclEntry> acl = new java.util.ArrayList<>(view.getAcl());
        acl.add(0, AclEntry.newBuilder().setType(AclEntryType.DENY).setPrincipal(TestStorage.outsider(file)).setPermissions(java.nio.file.attribute.AclEntryPermission.WRITE_DATA)
            .build());
        view.setAcl(acl);

        rule.requireProtected(file);
    }
}
