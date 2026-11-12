package io.github.jaeseongs95.portal.store.storage;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import io.github.jaeseongs95.portal.app.storage.ProtectionCheck;
import io.github.jaeseongs95.portal.app.storage.StorageArea;
import io.github.jaeseongs95.portal.store.StorageRoots;
import io.github.jaeseongs95.portal.store.TestStorage;

/** The guard of the file stores as the use cases ask it (RC-B-004, S3-UC-06): private folders are protected, a folder that others can use is the answer "unprotected". */
class PrivateStorageProtectionTest {

    @Test
    @DisplayName("S3-UC-06: folders that do not exist yet are created private to their owner and are protected; a second check finds them protected too")
    void missingFoldersAreCreatedPrivate(@TempDir Path base) throws IOException {
        Path root = TestStorage.privateFolder(base);
        PrivateStorageProtection protection = new PrivateStorageProtection(new StorageRoots(root.resolve("artifacts"), root.resolve("outputs")), TestStorage.rules());

        assertThat(protection.check()).isEqualTo(new ProtectionCheck.Protected());
        assertThat(Files.isDirectory(root.resolve("artifacts"))).isTrue();
        assertThat(Files.isDirectory(root.resolve("outputs"))).isTrue();
        assertThat(protection.check()).isEqualTo(new ProtectionCheck.Protected());
    }

    @Test
    @DisplayName("S3-UC-06 / RC-B-004: a folder that others can use is unprotected, named by its area, with the cause kept; the answer is a value and nothing is thrown")
    void anOpenFolderIsUnprotected(@TempDir Path base) throws IOException {
        Path root = TestStorage.privateFolder(base);
        Path outputs = Files.createDirectory(root.resolve("outputs"));
        TestStorage.privateFolder(outputs);
        TestStorage.openUp(outputs);
        PrivateStorageProtection protection = new PrivateStorageProtection(new StorageRoots(root.resolve("artifacts"), outputs), TestStorage.rules());

        ProtectionCheck check = protection.check();

        assertThat(check).isInstanceOfSatisfying(ProtectionCheck.Unprotected.class, unprotected -> {
            assertThat(unprotected.area()).isEqualTo(StorageArea.OUTPUTS);
            assertThat(unprotected.cause()).isInstanceOf(UnsafeStorageException.class);
        });
    }
}
