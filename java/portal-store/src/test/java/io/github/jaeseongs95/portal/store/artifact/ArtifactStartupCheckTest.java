package io.github.jaeseongs95.portal.store.artifact;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.FileSystemUtils;

import io.github.jaeseongs95.portal.app.artifact.ArtifactPayloadStore;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRecord;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRegistry;
import io.github.jaeseongs95.portal.app.artifact.ArtifactSpec;
import io.github.jaeseongs95.portal.app.artifact.ArtifactState;
import io.github.jaeseongs95.portal.app.artifact.ConsumeReason;
import io.github.jaeseongs95.portal.domain.contract.ArtifactErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.store.StorageRoots;
import io.github.jaeseongs95.portal.store.StoreTest;

/**
 * The start-up reconciliation of payload files and metadata (design 8.5), on a real folder and the real tables. The check is not called inside a transaction, so the
 * class runs without the slice's rollback ({@code NOT_SUPPORTED}); each test removes its rows and its files.
 */
@StoreTest
@Transactional(propagation = Propagation.NOT_SUPPORTED)
@Import({JdbcArtifactRegistry.class, ArtifactMapper.class, FileArtifactPayloadStore.class, ArtifactStartupCheck.class, ArtifactTestStorage.class})
class ArtifactStartupCheckTest {

    private static final Logger LOG = LoggerFactory.getLogger(ArtifactStartupCheckTest.class);

    @TestConfiguration(proxyBeanMethods = false)
    static class Limits {
        @Bean
        ArtifactLimits artifactLimits() {
            return new ArtifactLimits(ArtifactLimits.DEFAULT_BUDGET_BYTES, ArtifactLimits.MAX_FILE_BYTES, ArtifactLimits.CHUNK_BYTES, ArtifactLimits.UPLOAD_TTL, 0L);
        }
    }

    private final ArtifactFixtures fixtures = new ArtifactFixtures();
    private final ArtifactRegistry registry;
    private final ArtifactPayloadStore payloads;
    private final ArtifactStartupCheck startup;
    private final StorageRoots roots;
    private final StagedActionRowRepository actions;
    private final ArtifactChunkRowRepository chunks;
    private final ArtifactRowRepository artifacts;

    ArtifactStartupCheckTest(ArtifactRegistry registry, ArtifactPayloadStore payloads, ArtifactStartupCheck startup, StorageRoots roots,
                             StagedActionRowRepository actions, ArtifactChunkRowRepository chunks, ArtifactRowRepository artifacts) {
        this.registry = registry;
        this.payloads = payloads;
        this.startup = startup;
        this.roots = roots;
        this.actions = actions;
        this.chunks = chunks;
        this.artifacts = artifacts;
    }

    @AfterEach
    void removeRowsAndFiles() {
        actions.deleteAll();
        chunks.deleteAll();
        artifacts.deleteAll();
        try {
            FileSystemUtils.deleteRecursively(roots.artifacts());
        } catch (IOException e) {
            LOG.error("The test folder {} could not be removed", roots.artifacts(), e);
            throw new IllegalStateException("The test folder could not be removed", e);
        }
    }

    @Test
    @DisplayName("RC-A-162 / RC-B-093: a payload longer than the acknowledged bytes is cut back to them at start-up; a second run changes nothing")
    void anUnacknowledgedTailIsCutBack() {
        ArtifactId id = fixtures.reservedId(registry.reserve(fixtures.upload(16), fixtures.at()));
        byte[] acknowledged = {1, 2, 3, 4};
        appendBoth(id, 0, 0, acknowledged);
        payloads.append(id, 4, "uncommitted".getBytes(StandardCharsets.UTF_8));
        assertThat(payloads.length(id)).isEqualTo(4 + 11);

        ArtifactReconciliation first = startup.reconcile();

        assertThat(first.truncated()).containsExactly(id);
        assertThat(first.quarantined()).isEmpty();
        assertThat(payloads.length(id)).isEqualTo(4);
        assertThat(registry.find(id).orElseThrow().receivedBytes()).isEqualTo(4);
        assertThat(startup.reconcile().truncated()).isEmpty();
    }

    @Test
    @DisplayName("RC-A-162: acknowledged bytes that were changed are refused (the start is refused) and the changed file is left as it is")
    void aTamperedChunkRefusesTheStart() throws IOException {
        ArtifactId id = fixtures.reservedId(registry.reserve(fixtures.upload(16), fixtures.at()));
        appendBoth(id, 0, 0, new byte[] {1, 2, 3, 4});
        byte[] tampered = {9, 9, 9, 9};
        Files.write(file(id), tampered);

        assertCorrupted(id, ArtifactStoreCorruptedException.Reason.CHUNK_MISMATCH);

        assertThat(Files.readAllBytes(file(id))).isEqualTo(tampered);
    }

    @Test
    @DisplayName("RC-A-162: a payload shorter than the acknowledged bytes, or one that is missing, refuses the start")
    void aShorterOrMissingPayloadRefusesTheStart() throws IOException {
        ArtifactId shorter = fixtures.reservedId(registry.reserve(fixtures.upload(16), fixtures.at()));
        appendBoth(shorter, 0, 0, new byte[] {1, 2, 3, 4});
        Files.write(file(shorter), new byte[] {1, 2});
        assertCorrupted(shorter, ArtifactStoreCorruptedException.Reason.PAYLOAD_SHORTER);

        payloads.delete(shorter);
        assertCorrupted(shorter, ArtifactStoreCorruptedException.Reason.PAYLOAD_SHORTER);
    }

    @Test
    @DisplayName("S2-DB-09: the bytes are on disk before the metadata; when the metadata commit fails the byte tail is there, and the start-up check cuts it off so the chunk can be sent again")
    void aFailedMetadataCommitLeavesATailThatStartupCutsOff() {
        ArtifactId id = fixtures.reservedId(registry.reserve(fixtures.upload(4), fixtures.at()));
        byte[] chunk = {5, 6, 7, 8};

        payloads.append(id, 0, chunk);
        assertThat(payloads.length(id)).isEqualTo(4);
        assertRefused(() -> registry.append(id, 3, fixtures.chunk(chunk)), ArtifactErrorCode.ARTIFACT_CHUNK_CONFLICT);
        assertThat(registry.find(id).orElseThrow().receivedBytes()).isZero();

        ArtifactReconciliation report = startup.reconcile();

        assertThat(report.truncated()).containsExactly(id);
        assertThat(payloads.length(id)).isZero();
        payloads.append(id, 0, chunk);
        registry.append(id, 0, fixtures.chunk(chunk));
        assertThat(registry.markReady(id, fixtures.digest(chunk)).state()).isEqualTo(ArtifactState.READY);
        assertThat(startup.reconcile().truncated()).isEmpty();
    }

    @Test
    @DisplayName("RC-A-167: a row marked for deletion has its bytes deleted and its row released, whether the file is still there or not")
    void aCommittedDeletionIsFinished() {
        ArtifactId withFile = fixtures.reservedId(registry.reserve(fixtures.upload(8), fixtures.at()));
        appendBoth(withFile, 0, 0, new byte[] {1, 2, 3, 4});
        registry.beginDelete(withFile);
        ArtifactId withoutFile = fixtures.reservedId(registry.reserve(fixtures.upload(8), fixtures.at()));
        registry.beginDelete(withoutFile);

        ArtifactReconciliation report = startup.reconcile();

        assertThat(report.deleted()).containsExactlyInAnyOrder(withFile, withoutFile);
        assertThat(registry.find(withFile)).isEmpty();
        assertThat(registry.find(withoutFile)).isEmpty();
        assertThat(payloads.stored()).isEmpty();
        assertThat(registry.budget().chargedBytes()).isZero();
    }

    @Test
    @DisplayName("RC-A-167 / RC-A-169: a payload without metadata is quarantined with its bytes and does not stop the start; the next run finds nothing; the budget is the rows' only")
    void aPayloadWithoutMetadataIsQuarantined() throws IOException {
        ArtifactId legacy = new ArtifactId("f".repeat(48));
        byte[] bytes = fixtures.bytes(48, 'f');
        payloads.append(legacy, 0, bytes);

        ArtifactReconciliation report = startup.reconcile();

        assertThat(report.quarantined()).containsExactly(legacy);
        assertThat(payloads.stored()).isEmpty();
        assertThat(Files.readAllBytes(roots.artifacts().resolve("orphans").resolve(legacy.value() + ".part"))).isEqualTo(bytes);
        assertThat(startup.reconcile().quarantined()).isEmpty();
        assertThat(registry.budget().chargedBytes()).isZero();
    }

    @Test
    @DisplayName("RC-A-176: pending, partial and finished artifacts keep their metadata and their bytes through the start-up check; nothing is cut, moved or deleted")
    void aHealthyStoreIsLeftAlone() throws IOException {
        ArtifactId finished = readyWithFile(fixtures.upload(4), new byte[] {1, 1, 1, 1});
        ArtifactId pending = readyWithFile(fixtures.upload(4), new byte[] {2, 2, 2, 2});
        registry.submit(pending, new OperationId("a".repeat(48)));
        ArtifactId partial = fixtures.reservedId(registry.reserve(fixtures.download(8), fixtures.at()));
        appendBoth(partial, 0, 0, new byte[] {3, 3, 3, 3});
        ArtifactRecord pendingBefore = registry.find(pending).orElseThrow();
        ArtifactRecord partialBefore = registry.find(partial).orElseThrow();
        ArtifactRecord finishedBefore = registry.find(finished).orElseThrow();

        ArtifactReconciliation report = startup.reconcile();

        assertThat(report.quarantined()).isEmpty();
        assertThat(report.truncated()).isEmpty();
        assertThat(report.deleted()).isEmpty();
        assertThat(report.unfinishedConsumptions()).isEmpty();
        assertThat(registry.find(pending)).contains(pendingBefore);
        assertThat(registry.find(partial)).contains(partialBefore);
        assertThat(registry.find(finished)).contains(finishedBefore);
        assertThat(Files.readAllBytes(file(pending))).isEqualTo(new byte[] {2, 2, 2, 2});
        assertThat(Files.readAllBytes(file(partial))).isEqualTo(new byte[] {3, 3, 3, 3});
        assertThat(payloads.stored()).containsExactlyInAnyOrder(finished, pending, partial);
    }

    @Test
    @DisplayName("RC-A-181 / RC-B-094: an empty file has no payload file and is not an error; a reserved file that never received a byte is not an error either")
    void filesWithoutBytesAreNotErrors() {
        ArtifactId empty = fixtures.readyArtifact(registry, fixtures.upload(0), new byte[0]);
        ArtifactId reserved = fixtures.reservedId(registry.reserve(fixtures.upload(4), fixtures.at()));

        ArtifactReconciliation report = startup.reconcile();

        assertThat(report.truncated()).isEmpty();
        assertThat(payloads.stored()).isEmpty();
        assertThat(registry.find(empty).orElseThrow().state()).isEqualTo(ArtifactState.READY);
        assertThat(registry.find(reserved).orElseThrow().state()).isEqualTo(ArtifactState.STAGING);
    }

    @Test
    @DisplayName("RC-B-095: a consumption that was begun and not completed is reported and left as it is, with its bytes; one without a file is not an error")
    void anOpenConsumptionIsReported() {
        ArtifactId withFile = readyWithFile(fixtures.stagedFile(4), new byte[] {4, 4, 4, 4});
        registry.beginConsume(withFile);
        ArtifactId withoutFile = fixtures.readyArtifact(registry, fixtures.stagedFile(0), new byte[0]);
        registry.beginConsume(withoutFile);

        ArtifactReconciliation report = startup.reconcile();

        assertThat(report.unfinishedConsumptions()).containsExactlyInAnyOrder(withFile, withoutFile);
        assertThat(registry.find(withFile).orElseThrow().state()).isEqualTo(ArtifactState.CONSUMING);
        assertThat(payloads.length(withFile)).isEqualTo(4);
        assertThat(report.quarantined()).isEmpty();
    }

    @Test
    @DisplayName("RC-B-095: bytes left behind by a consumed row are quarantined, not deleted and not re-adopted")
    void bytesOfAConsumedRowAreQuarantined() {
        ArtifactId id = readyWithFile(fixtures.stagedFile(4), new byte[] {4, 4, 4, 4});
        registry.beginConsume(id);
        registry.completeConsume(id, ConsumeReason.MOVED);

        ArtifactReconciliation report = startup.reconcile();

        assertThat(report.quarantined()).containsExactly(id);
        assertThat(payloads.stored()).isEmpty();
        assertThat(registry.find(id).orElseThrow().state()).isEqualTo(ArtifactState.CONSUMED);
    }

    @Test
    @DisplayName("RC-A-166: a symbolic link in place of a payload refuses the start and the link's target is not touched (runs where the file store allows symbolic links)")
    void aSymbolicLinkPayloadRefusesTheStart() throws IOException {
        payloads.stored();
        Path target = Files.write(roots.artifacts().getParent().resolve("symlink-target.bin"), new byte[] {9, 9});
        ArtifactId id = new ArtifactId("e".repeat(48));
        Assumptions.assumeTrue(canLink(roots.artifacts().resolve(id.value() + ".part"), target), "the file store of the test folder does not allow symbolic links; runs on the Linux CI (Linux CI에서 실행)");

        assertRefused(startup::reconcile, ArtifactErrorCode.ARTIFACT_STORAGE_UNSAFE);

        assertThat(Files.readAllBytes(target)).isEqualTo(new byte[] {9, 9});
        Files.delete(target);
    }

    private ArtifactId readyWithFile(ArtifactSpec spec, byte[] bytes) {
        ArtifactId id = fixtures.reservedId(registry.reserve(spec, fixtures.at()));
        appendBoth(id, 0, 0, bytes);
        registry.markReady(id, fixtures.digest(bytes));
        return id;
    }

    /** The order of the use case: the bytes first (forced to disk), the metadata second. */
    private void appendBoth(ArtifactId id, int chunkNo, long offset, byte[] bytes) {
        payloads.append(id, offset, bytes);
        registry.append(id, chunkNo, fixtures.chunk(bytes));
    }

    private Path file(ArtifactId id) {
        return roots.artifacts().resolve(id.value() + ".part");
    }

    private boolean canLink(Path link, Path target) {
        try {
            Files.createSymbolicLink(link, target);
            return true;
        } catch (IOException | UnsupportedOperationException e) {
            LOG.info("Symbolic links are not available for {}", link, e);
            return false;
        }
    }

    private void assertCorrupted(ArtifactId id, ArtifactStoreCorruptedException.Reason reason) {
        assertThatThrownBy(startup::reconcile).isInstanceOfSatisfying(ArtifactStoreCorruptedException.class, e -> {
            assertThat(e.artifactId()).isEqualTo(id);
            assertThat(e.reason()).isEqualTo(reason);
        });
    }

    private void assertRefused(ThrowingCallable call, ArtifactErrorCode code) {
        assertThatThrownBy(call).isInstanceOfSatisfying(RequestRefusedException.class, e -> assertThat(e.code()).isEqualTo(code));
    }
}
