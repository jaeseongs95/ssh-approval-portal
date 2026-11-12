package io.github.jaeseongs95.portal.store.storage;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import io.github.jaeseongs95.portal.app.audit.AuditAction;
import io.github.jaeseongs95.portal.app.audit.AuditEvent;
import io.github.jaeseongs95.portal.app.audit.AuditFailedException;
import io.github.jaeseongs95.portal.domain.contract.ArtifactErrorCode;
import io.github.jaeseongs95.portal.domain.contract.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.store.StorageRoots;
import io.github.jaeseongs95.portal.store.TestStorage;
import io.github.jaeseongs95.portal.store.artifact.FileArtifactPayloadStore;
import io.github.jaeseongs95.portal.store.audit.AuditFileLocation;
import io.github.jaeseongs95.portal.store.audit.JsonlAuditLog;
import io.github.jaeseongs95.portal.store.output.OutputFiles;
import tools.jackson.databind.json.JsonMapper;

/**
 * S2-DB-10: the three stores that write sensitive bytes (artifacts, command outputs, the audit file) use one protection rule and refuse what is not protected, on every
 * file store: a folder or a file that others can use, and a file store that has neither permission bits nor an access control list. The tests run on whatever file store the
 * machine has (no skip): the folder is opened up with the means of that file store ({@code TestStorage#openUp}), so on this Windows PC they change real NTFS ACLs.
 */
class PrivateStorageStoresTest {

    private static final ArtifactId ARTIFACT = new ArtifactId("a".repeat(48));
    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-12T00:00:00Z"), ZoneOffset.UTC);
    private static final OperationId OPERATION = new OperationId("b".repeat(48));

    private final JsonMapper mapper = JsonMapper.builder().build();

    @Test
    @DisplayName("S2-DB-10, RC-A-178: the artifact store makes its folder and its files private on this file store, and uses them")
    void theArtifactStoreCreatesPrivatePaths(@TempDir Path directory) throws IOException {
        Path root = directory.resolve("artifacts");
        FileArtifactPayloadStore store = new FileArtifactPayloadStore(new StorageRoots(root, directory.resolve("outputs")), TestStorage.rules());

        assertThat(store.append(ARTIFACT, 0, new byte[] {1, 2, 3}).storedBytes()).isEqualTo(3);

        TestStorage.rules().requireSafeFolder(root);
        TestStorage.rules().requireSafeFile(root.resolve(ARTIFACT.value() + ".part"));
        assertThat(store.length(ARTIFACT)).isEqualTo(3);
    }

    @Test
    @DisplayName("S2-DB-10, RC-A-179: the artifact store refuses a root folder that others can use with ARTIFACT_STORAGE_UNSAFE, creates nothing in it and changes nothing")
    void theArtifactStoreRefusesAnOpenFolder(@TempDir Path directory) throws IOException {
        Path root = Files.createDirectory(directory.resolve("artifacts"));
        TestStorage.openUp(root);
        FileArtifactPayloadStore store = new FileArtifactPayloadStore(new StorageRoots(root, directory.resolve("outputs")), TestStorage.rules());

        assertThatThrownBy(() -> store.append(ARTIFACT, 0, new byte[] {1})).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(ArtifactErrorCode.ARTIFACT_STORAGE_UNSAFE));
        assertThatThrownBy(store::usable).isInstanceOf(RequestRefusedException.class);
        try (var entries = Files.list(root)) {
            assertThat(entries.toList()).isEmpty();
        }
    }

    @Test
    @DisplayName("S2-DB-10, RC-A-179: the artifact store refuses a payload file that others can use and does not touch its bytes")
    void theArtifactStoreRefusesAnOpenFile(@TempDir Path directory) throws IOException {
        Path root = directory.resolve("artifacts");
        FileArtifactPayloadStore store = new FileArtifactPayloadStore(new StorageRoots(root, directory.resolve("outputs")), TestStorage.rules());
        store.append(ARTIFACT, 0, new byte[] {1, 2, 3});
        Path file = root.resolve(ARTIFACT.value() + ".part");
        TestStorage.openUp(file);

        assertThatThrownBy(() -> store.append(ARTIFACT, 3, new byte[] {4})).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(ArtifactErrorCode.ARTIFACT_STORAGE_UNSAFE));
        assertThatThrownBy(() -> store.length(ARTIFACT)).isInstanceOf(RequestRefusedException.class);
        assertThat(Files.readAllBytes(file)).isEqualTo(new byte[] {1, 2, 3});
    }

    @Test
    @DisplayName("S2-DB-10: a file store that no rule supports is refused by the artifact store with ARTIFACT_STORAGE_UNSAFE, not accepted as not checked")
    void theArtifactStoreRefusesAFileStoreWithoutARule(@TempDir Path directory) {
        FileArtifactPayloadStore store = new FileArtifactPayloadStore(new StorageRoots(directory.resolve("artifacts"), directory.resolve("outputs")), new PrivateStorages(List.of()));

        assertThatThrownBy(() -> store.append(ARTIFACT, 0, new byte[] {1})).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(ArtifactErrorCode.ARTIFACT_STORAGE_UNSAFE));
        assertThat(Files.exists(directory.resolve("artifacts"), LinkOption.NOFOLLOW_LINKS)).isFalse();
    }

    @Test
    @DisplayName("S2-DB-10, RC-A-179: the output folder is private, an open one is refused (the output has no code of its own: OUTPUT_CAPTURE_FAILED), and so is a file store without a rule")
    void theOutputFilesRefuseWhatIsNotPrivate(@TempDir Path directory) throws IOException {
        Path created = directory.resolve("created");
        OutputFiles files = new OutputFiles(new StorageRoots(directory, created), TestStorage.rules());
        assertThat(files.directory()).isEqualTo(created.toAbsolutePath());
        TestStorage.rules().requireSafeFolder(created);

        Path open = Files.createDirectory(directory.resolve("open"));
        TestStorage.openUp(open);
        OutputFiles openFiles = new OutputFiles(new StorageRoots(directory, open), TestStorage.rules());
        assertThatThrownBy(openFiles::directory).isInstanceOfSatisfying(RequestRefusedException.class, e -> assertThat(e.code()).isEqualTo(ExecutionErrorCode.OUTPUT_CAPTURE_FAILED));

        OutputFiles withoutRule = new OutputFiles(new StorageRoots(directory, directory.resolve("other")), new PrivateStorages(List.of()));
        assertThatThrownBy(withoutRule::directory).isInstanceOf(RequestRefusedException.class);
        assertThat(Files.exists(directory.resolve("other"), LinkOption.NOFOLLOW_LINKS)).isFalse();
    }

    @Test
    @DisplayName("S2-DB-10: the audit file is created private, and an audit file that others can use is refused when the log opens it, without a byte written")
    void theAuditFileIsPrivate(@TempDir Path directory) throws IOException {
        Path created = directory.resolve("logs").resolve("audit.jsonl");
        try (JsonlAuditLog log = new JsonlAuditLog(new AuditFileLocation(created), CLOCK, mapper, TestStorage.rules())) {
            log.append(new AuditEvent(AuditAction.SUBMITTED, OPERATION, "kept"));
        }
        TestStorage.rules().requireSafeFile(created);

        TestStorage.openUp(created);
        byte[] before = Files.readAllBytes(created);

        assertThatThrownBy(() -> new JsonlAuditLog(new AuditFileLocation(created), CLOCK, mapper, TestStorage.rules())).isInstanceOf(AuditFailedException.class);
        assertThat(Files.readAllBytes(created)).isEqualTo(before);
        assertThat(new String(before, StandardCharsets.UTF_8)).contains("\"note\":\"kept\"");
    }

    @Test
    @DisplayName("S2-DB-10: an audit file on a file store that no rule supports is refused")
    void theAuditFileRefusesAFileStoreWithoutARule(@TempDir Path directory) {
        Path file = directory.resolve("audit.jsonl");

        assertThatThrownBy(() -> new JsonlAuditLog(new AuditFileLocation(file), CLOCK, mapper, new PrivateStorages(List.of()))).isInstanceOf(AuditFailedException.class);
        assertThat(Files.exists(file, LinkOption.NOFOLLOW_LINKS)).isFalse();
    }
}
