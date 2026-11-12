package io.github.jaeseongs95.portal.store.storage;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Set;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The protection of the stores on a file store with permission bits (a Linux or macOS volume). */
class PosixPrivateStorageTest {

    private final PosixPrivateStorage rule = new PosixPrivateStorage();

    @TempDir
    Path directory;

    @BeforeEach
    void onlyWhereTheFileStoreHasPermissionBits() throws IOException {
        Assumptions.assumeTrue(rule.supports(Files.getFileStore(directory)),
            "the file store of the test folder has no posix view (it is an NTFS volume); runs on the Linux CI (Linux CI에서 실행)");
    }

    @Test
    @DisplayName("S2-DB-10, RC-A-178: a folder made by the rule is rwx------ and a file made by it is rw-------, and the check accepts both")
    void newPathsAreOwnerOnly() throws IOException {
        Path folder = directory.resolve("private");
        rule.createFolder(folder);
        Path file = folder.resolve("payload.part");
        try (FileChannel channel = rule.open(file, Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS))) {
            assertThat(channel.size()).isZero();
        }

        assertThat(Files.getPosixFilePermissions(folder)).isEqualTo(PosixFilePermissions.fromString("rwx------"));
        assertThat(Files.getPosixFilePermissions(file)).isEqualTo(PosixFilePermissions.fromString("rw-------"));
        rule.requireProtected(folder);
        rule.requireProtected(file);
    }

    @Test
    @DisplayName("S2-DB-10, RC-A-179: a folder or a file that the group or others can use is refused and its bytes are not touched")
    void groupAndOthersAreRefused() throws IOException {
        Path folder = directory.resolve("shared");
        rule.createFolder(folder);
        Path file = Files.writeString(folder.resolve("payload.part"), "bytes");
        Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"));

        Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r-----"));
        assertThatThrownBy(() -> rule.requireProtected(file)).isInstanceOf(UnsafeStorageException.class);
        Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"));
        Files.setPosixFilePermissions(folder, PosixFilePermissions.fromString("rwxr-xr-x"));
        assertThatThrownBy(() -> rule.requireProtected(folder)).isInstanceOf(UnsafeStorageException.class);
        assertThat(Files.readString(file)).isEqualTo("bytes");
    }

    @Test
    @DisplayName("S2-DB-10, RC-A-171: a file with a second hard link is refused where the file store reports link counts")
    void aSecondHardLinkIsRefused() throws IOException {
        Assumptions.assumeTrue(Files.getFileStore(directory).supportsFileAttributeView("unix"), "the file store reports no link counts; runs on the Linux CI (Linux CI에서 실행)");
        Path folder = directory.resolve("links");
        rule.createFolder(folder);
        Path file = Files.writeString(folder.resolve("payload.part"), "bytes");
        Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"));
        rule.requireProtected(file);

        Files.createLink(folder.resolve("second-name"), file);

        assertThatThrownBy(() -> rule.requireProtected(file)).isInstanceOf(UnsafeStorageException.class).hasMessageContaining("hard link");
    }
}
