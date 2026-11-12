package io.github.jaeseongs95.portal.store.artifact;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;

import io.github.jaeseongs95.portal.app.artifact.ArtifactDestination;
import io.github.jaeseongs95.portal.app.artifact.ArtifactOrigin;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRecord;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRegistry;
import io.github.jaeseongs95.portal.app.artifact.ArtifactReservation;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRetention;
import io.github.jaeseongs95.portal.app.artifact.ArtifactSpec;
import io.github.jaeseongs95.portal.app.artifact.ArtifactState;
import io.github.jaeseongs95.portal.app.artifact.ArtifactSubmission;
import io.github.jaeseongs95.portal.app.artifact.BindingKind;
import io.github.jaeseongs95.portal.app.artifact.ConsumeReason;
import io.github.jaeseongs95.portal.app.artifact.ConsumeState;
import io.github.jaeseongs95.portal.app.artifact.ContentDigest;
import io.github.jaeseongs95.portal.app.artifact.ReleaseReason;
import io.github.jaeseongs95.portal.app.artifact.ReservedSplit;
import io.github.jaeseongs95.portal.app.artifact.StagedAction;
import io.github.jaeseongs95.portal.app.artifact.StagedActionKind;
import io.github.jaeseongs95.portal.app.artifact.StagedActionState;
import io.github.jaeseongs95.portal.app.artifact.UnpinReason;
import io.github.jaeseongs95.portal.domain.error.ArtifactErrorCode;
import io.github.jaeseongs95.portal.domain.error.ErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.ArtifactUuid;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.Elevation;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.operation.UploadProtocol;
import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import io.github.jaeseongs95.portal.domain.path.WindowsRemotePath;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import io.github.jaeseongs95.portal.store.Savepoints;
import io.github.jaeseongs95.portal.store.StoreTest;

/**
 * The registry with the 2.x default limits (512 MiB budget, 64 MiB per file, 10 minute staging) and no disk margin, so that these cases never depend on how full the
 * disk of the machine is. The slice rolls every test back.
 */
@StoreTest
@Import({JdbcArtifactRegistry.class, ArtifactMapper.class, FileArtifactPayloadStore.class, ArtifactTestStorage.class})
class JdbcArtifactRegistryTest {

    private static final long MAX_FILE = ArtifactLimits.MAX_FILE_BYTES;
    private static final OperationId OPERATION_A = new OperationId("a".repeat(48));
    private static final OperationId OPERATION_B = new OperationId("b".repeat(48));

    @TestConfiguration(proxyBeanMethods = false)
    static class Limits {
        @Bean
        ArtifactLimits artifactLimits() {
            return new ArtifactLimits(ArtifactLimits.DEFAULT_BUDGET_BYTES, MAX_FILE, ArtifactLimits.CHUNK_BYTES, ArtifactLimits.UPLOAD_TTL, 0L);
        }
    }

    private final ArtifactFixtures fixtures = new ArtifactFixtures();
    private final ArtifactRegistry registry;
    private final Savepoints savepoints;

    JdbcArtifactRegistryTest(ArtifactRegistry registry, Savepoints savepoints) {
        this.registry = registry;
        this.savepoints = savepoints;
    }

    @Test
    @DisplayName("RC-B-440: eight files of the 64 MiB limit fill the 512 MiB budget with no content allocated; the ninth is refused; releasing all gives it back")
    void eightLimitFilesFillTheDefaultBudget() {
        List<ArtifactId> ids = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            ids.add(fixtures.reservedId(registry.reserve(fixtures.upload(MAX_FILE), fixtures.at())));
        }

        assertThat(registry.budget().budgetBytes()).isEqualTo(536_870_912L);
        assertThat(registry.budget().chargedBytes()).isEqualTo(536_870_912L);
        assertThat(registry.budget().remainingBytes()).isZero();
        assertThat(registry.reserve(fixtures.upload(MAX_FILE), fixtures.at())).isEqualTo(new ArtifactReservation.BudgetExceeded(MAX_FILE, new ReservedSplit(536_870_912L, 0), 536_870_912L));
        assertThat(registry.holding()).hasSize(8);

        ids.forEach(id -> registry.release(id, ReleaseReason.REFUSED));
        assertThat(registry.budget().chargedBytes()).isZero();
        assertThat(registry.holding()).isEmpty();
    }

    @Test
    @DisplayName("RC-A-158: a staging upload expires after 10 minutes and is listed from that instant on; a submitted upload is pinned and never listed")
    void aStagingUploadExpiresAndASubmittedOneIsPinned() {
        ArtifactId partial = fixtures.reservedId(registry.reserve(fixtures.upload(4), fixtures.at()));
        ArtifactId submitted = fixtures.readyArtifact(registry, fixtures.upload(4), fixtures.bytes(4, 1));
        registry.submit(submitted, OPERATION_A);

        assertThat(registry.find(partial).orElseThrow().expiresAt()).isEqualTo(ArtifactFixtures.T0.plus(Duration.ofMinutes(10)));
        assertThat(registry.expired(ArtifactFixtures.T0.plus(Duration.ofMinutes(10)).minusMillis(1))).isEmpty();
        assertThat(registry.expired(ArtifactFixtures.T0.plus(Duration.ofMinutes(10)).plusMillis(1))).extracting(ArtifactRecord::id).containsExactly(partial);
        assertThat(registry.expired(ArtifactFixtures.T0.plus(Duration.ofMinutes(10)))).extracting(ArtifactRecord::id).containsExactly(partial);

        registry.release(partial, ReleaseReason.EXPIRED);
        assertThat(registry.find(partial)).isEmpty();
        ArtifactRecord kept = registry.find(submitted).orElseThrow();
        assertThat(kept.spec().retention()).isEqualTo(ArtifactRetention.PINNED);
        assertThat(kept.submission()).isEqualTo(new ArtifactSubmission.SubmittedAs(OPERATION_A));
        assertThat(registry.expired(ArtifactFixtures.T0.plus(Duration.ofHours(2)))).isEmpty();
    }

    @Test
    @DisplayName("S3-AR-07: a submitted upload is pinned and not listed; once its operation settled, unpin gives it back to the expiry, and a second unpin changes nothing")
    void anUnpinnedArtifactExpiresAgain() {
        ArtifactId submitted = fixtures.readyArtifact(registry, fixtures.upload(4), fixtures.bytes(4, 1));
        registry.submit(submitted, OPERATION_A);
        assertThat(registry.expired(ArtifactFixtures.T0.plus(Duration.ofHours(2)))).as("pinned while the operation depends on it").isEmpty();

        ArtifactRecord unpinned = registry.unpin(submitted, UnpinReason.OPERATION_SETTLED);

        assertThat(unpinned.spec().retention()).isEqualTo(ArtifactRetention.RELEASABLE);
        assertThat(unpinned.submission()).as("the link to the operation stays").isEqualTo(new ArtifactSubmission.SubmittedAs(OPERATION_A));
        assertThat(registry.expired(ArtifactFixtures.T0.plus(Duration.ofHours(2)))).extracting(ArtifactRecord::id).containsExactly(submitted);
        assertThat(registry.unpin(submitted, UnpinReason.OPERATION_SETTLED).version()).isEqualTo(unpinned.version());
        assertRefused(() -> registry.unpin(new ArtifactId("9".repeat(48)), UnpinReason.OPERATION_SETTLED), ArtifactErrorCode.ARTIFACT_NOT_FOUND);
    }

    @Test
    @DisplayName("RC-A-772 / D3-17: a download reserves the largest size, receives fewer bytes and completes with the real size, so the charge falls to what was received; an upload cannot complete this way")
    void aCompletedDownloadChargesWhatItReceived() {
        ArtifactId id = fixtures.reservedId(registry.reserve(fixtures.download(64), fixtures.at()));
        assertThat(registry.budget().chargedBytes()).isEqualTo(64);
        byte[] bytes = fixtures.bytes(4, 7);
        registry.append(id, 0, fixtures.chunk(bytes));
        assertRefused(() -> registry.markReady(id, fixtures.digest(bytes)), ArtifactErrorCode.ARTIFACT_INCOMPLETE);

        ArtifactRecord ready = registry.completeDownload(id, fixtures.digest(bytes));

        assertThat(ready.state()).isEqualTo(ArtifactState.READY);
        assertThat(ready.spec().sizeBytes()).isEqualTo(4);
        assertThat(ready.content()).isEqualTo(new ContentDigest.Sealed(fixtures.digest(bytes)));
        assertThat(registry.budget().chargedBytes()).isEqualTo(4);
        assertThat(registry.completeDownload(id, fixtures.digest(bytes))).isEqualTo(ready);
        ArtifactId upload = fixtures.reservedId(registry.reserve(fixtures.upload(4), fixtures.at()));
        assertRefused(() -> registry.completeDownload(upload, fixtures.digest(bytes)), ArtifactErrorCode.ARTIFACT_NOT_WRITABLE);
    }

    @Test
    @DisplayName("RC-A-161: chunks are acknowledged in order, the registry keeps the received count and every chunk digest, and a repeated or skipped chunk number is a conflict")
    void chunksAreAcknowledgedInOrder() {
        byte[] first = {1, 2};
        byte[] second = {3, 4, 5};
        ArtifactId id = fixtures.reservedId(registry.reserve(fixtures.upload(5), fixtures.at()));

        ArtifactRecord afterFirst = registry.append(id, 0, fixtures.chunk(first));
        assertThat(afterFirst.receivedBytes()).isEqualTo(2);
        assertThat(afterFirst.chunkCount()).isEqualTo(1);
        assertRefused(() -> registry.append(id, 0, fixtures.chunk(first)), ArtifactErrorCode.ARTIFACT_CHUNK_CONFLICT);
        assertRefused(() -> registry.append(id, 2, fixtures.chunk(second)), ArtifactErrorCode.ARTIFACT_CHUNK_CONFLICT);
        assertRefused(() -> registry.append(id, 1, fixtures.chunk(fixtures.bytes(4, 9))), ArtifactErrorCode.ARTIFACT_SEQUENCE_OR_SIZE);

        ArtifactRecord afterSecond = registry.append(id, 1, fixtures.chunk(second));
        assertThat(afterSecond.receivedBytes()).isEqualTo(5);
        assertThat(afterSecond.version()).isGreaterThan(afterFirst.version());
        assertThat(registry.chunks(id)).containsExactly(fixtures.chunk(first), fixtures.chunk(second));

        ArtifactRecord ready = registry.markReady(id, fixtures.digest(new byte[] {1, 2, 3, 4, 5}));
        assertThat(ready.state()).isEqualTo(ArtifactState.READY);
        assertThat(registry.find(id)).contains(ready);
        assertThat(registry.budget().chargedBytes()).isEqualTo(5);
    }

    @Test
    @DisplayName("RC-A-163: a completed download keeps its expiry (+1 hour) and its charge in the metadata; the row is released only after the bytes are marked for deletion")
    void aCompletedDownloadKeepsExpiryAndCharge() {
        byte[] bytes = {7, 8, 9};
        ArtifactId id = fixtures.readyArtifact(registry, fixtures.download(3), bytes);

        ArtifactRecord record = registry.find(id).orElseThrow();
        assertThat(record.expiresAt()).isEqualTo(ArtifactFixtures.T0.plus(ArtifactFixtures.ONE_HOUR));
        assertThat(record.content()).isEqualTo(new ContentDigest.Sealed(fixtures.digest(bytes)));
        assertThat(registry.budget().chargedBytes()).isEqualTo(3);
        assertThat(registry.expired(ArtifactFixtures.T0.plus(ArtifactFixtures.ONE_HOUR).minusMillis(1))).isEmpty();
        assertThat(registry.expired(ArtifactFixtures.T0.plus(ArtifactFixtures.ONE_HOUR))).extracting(ArtifactRecord::id).containsExactly(id);

        assertRefused(() -> registry.release(id, ReleaseReason.EXPIRED), ArtifactErrorCode.ARTIFACT_CHANGED);
        assertThat(registry.beginDelete(id).state()).isEqualTo(ArtifactState.DELETING);
        registry.release(id, ReleaseReason.EXPIRED);
        assertThat(registry.find(id)).isEmpty();
        assertThat(registry.budget().chargedBytes()).isZero();
    }

    @Test
    @DisplayName("RC-A-164: the operation made from an upload is bound to it; the same operation is answered again, another one is refused, a partial upload cannot be submitted")
    void theSubmissionIsBoundToTheArtifact() {
        ArtifactId partial = fixtures.reservedId(registry.reserve(fixtures.upload(4), fixtures.at()));
        ArtifactId ready = fixtures.readyArtifact(registry, fixtures.upload(4), fixtures.bytes(4, 2));

        assertRefused(() -> registry.submit(partial, OPERATION_A), ArtifactErrorCode.ARTIFACT_NOT_READY);
        ArtifactRecord submitted = registry.submit(ready, OPERATION_A);
        assertThat(submitted.submission()).isEqualTo(new ArtifactSubmission.SubmittedAs(OPERATION_A));
        assertThat(registry.submit(ready, OPERATION_A)).isEqualTo(submitted);
        assertRefused(() -> registry.submit(ready, OPERATION_B), ArtifactErrorCode.ARTIFACT_ALREADY_SUBMITTED);
        assertThat(registry.find(ready).orElseThrow().submission()).isEqualTo(new ArtifactSubmission.SubmittedAs(OPERATION_A));
    }

    @Test
    @DisplayName("RC-A-168: an expired partial upload accepts no more bytes once it is marked for deletion, and its release gives the budget back")
    void anExpiredPartialUploadIsReleased() {
        ArtifactId id = fixtures.reservedId(registry.reserve(fixtures.upload(8), fixtures.at()));
        registry.append(id, 0, fixtures.chunk(fixtures.bytes(4, 3)));

        assertThat(registry.expired(ArtifactFixtures.T0.plus(Duration.ofMinutes(10)))).extracting(ArtifactRecord::id).containsExactly(id);
        assertThat(registry.beginDelete(id).state()).isEqualTo(ArtifactState.DELETING);
        assertThat(registry.beginDelete(id).state()).isEqualTo(ArtifactState.DELETING);
        assertRefused(() -> registry.append(id, 1, fixtures.chunk(fixtures.bytes(4, 3))), ArtifactErrorCode.ARTIFACT_NOT_WRITABLE);
        registry.release(id, ReleaseReason.EXPIRED);

        assertThat(registry.budget().chargedBytes()).isZero();
        assertThat(registry.chunks(id)).isEmpty();
    }

    @Test
    @DisplayName("RC-A-172: the budget is counted in bytes, not in items: 101 empty files are accepted and each charges one byte")
    void theBudgetIsInBytesNotItems() {
        for (int i = 0; i < 101; i++) {
            ArtifactId id = fixtures.readyArtifact(registry, fixtures.upload(0), new byte[0]);
            assertThat(registry.find(id).orElseThrow().state()).isEqualTo(ArtifactState.READY);
        }

        assertThat(registry.holding()).hasSize(101);
        assertThat(registry.budget().chargedBytes()).isEqualTo(101);
    }

    @Test
    @DisplayName("RC-A-176: pending (pinned) and partial artifacts keep every field; only the finished artifact is listed as expired and its release leaves the others' charge")
    void pendingAndPartialArtifactsAreKept() {
        ArtifactId finished = fixtures.readyArtifact(registry, fixtures.upload(4), fixtures.bytes(4, 1));
        ArtifactId pending = fixtures.readyArtifact(registry, fixtures.upload(4), fixtures.bytes(4, 2));
        registry.submit(pending, OPERATION_A);
        ArtifactId partial = fixtures.reservedId(registry.reserve(fixtures.download(8), fixtures.at()));
        registry.append(partial, 0, fixtures.chunk(fixtures.bytes(4, 3)));
        ArtifactRecord pendingBefore = registry.find(pending).orElseThrow();
        ArtifactRecord partialBefore = registry.find(partial).orElseThrow();

        assertThat(registry.expired(ArtifactFixtures.T0.plus(Duration.ofMinutes(11)))).extracting(ArtifactRecord::id).containsExactly(finished);
        registry.beginDelete(finished);
        registry.release(finished, ReleaseReason.CONSUMED);

        assertThat(registry.find(finished)).isEmpty();
        assertThat(registry.find(pending)).contains(pendingBefore);
        assertThat(registry.find(partial)).contains(partialBefore);
        assertThat(registry.budget().chargedBytes()).isEqualTo(4 + 8);
        assertThat(pendingBefore.state()).isEqualTo(ArtifactState.READY);
        assertThat(partialBefore.state()).isEqualTo(ArtifactState.STAGING);
    }

    @Test
    @DisplayName("RC-A-177: releasing an unknown or already released artifact is a repeatable no-op; the artifact is gone from find")
    void releasingAnUnknownArtifactRepeats() {
        ArtifactId id = fixtures.reservedId(registry.reserve(fixtures.upload(4), fixtures.at()));

        registry.release(id, ReleaseReason.ABANDONED);
        registry.release(id, ReleaseReason.ABANDONED);
        registry.release(new ArtifactId("0".repeat(48)), ReleaseReason.ABANDONED);

        assertThat(registry.find(id)).isEmpty();
        assertThat(registry.budget().chargedBytes()).isZero();
    }

    @Test
    @DisplayName("RC-A-180: a chunk past the declared size is refused, nothing is written after READY, an empty file is accepted, and a second digest for a READY file is a hash mismatch")
    void binaryAndEmptyUploadsAreBoundToTheirDigest() {
        byte[] bytes = {0, (byte) 255, 13, 10};
        ArtifactId id = fixtures.reservedId(registry.reserve(fixtures.upload(4), fixtures.at()));

        assertRefused(() -> registry.append(id, 0, fixtures.chunk(fixtures.bytes(5, 1))), ArtifactErrorCode.ARTIFACT_SEQUENCE_OR_SIZE);
        registry.append(id, 0, fixtures.chunk(bytes));
        ArtifactRecord ready = registry.markReady(id, fixtures.digest(bytes));
        assertThat(registry.markReady(id, fixtures.digest(bytes))).isEqualTo(ready);
        assertRefused(() -> registry.markReady(id, fixtures.digest(new byte[] {1})), ArtifactErrorCode.ARTIFACT_HASH_MISMATCH);
        assertRefused(() -> registry.append(id, 1, fixtures.chunk(new byte[] {1})), ArtifactErrorCode.ARTIFACT_NOT_WRITABLE);

        ArtifactId empty = fixtures.readyArtifact(registry, fixtures.upload(0), new byte[0]);
        assertThat(registry.find(empty).orElseThrow().content()).isEqualTo(new ContentDigest.Sealed(fixtures.digest(new byte[0])));
        assertThat(registry.find(id).orElseThrow().spec().fileName().value()).isEqualTo("한글.bin");
    }

    @Test
    @DisplayName("RC-A-181: a file that has not received all its bytes cannot be marked ready; a reserved file that received nothing is released with its budget")
    void anIncompleteUploadCannotBeMarkedReady() {
        ArtifactId id = fixtures.reservedId(registry.reserve(fixtures.upload(4), fixtures.at()));

        assertRefused(() -> registry.markReady(id, fixtures.digest(fixtures.bytes(4, 1))), ArtifactErrorCode.ARTIFACT_INCOMPLETE);
        assertThat(registry.find(id).orElseThrow().state()).isEqualTo(ArtifactState.STAGING);
        assertThat(registry.expired(ArtifactFixtures.T0.plus(Duration.ofMinutes(10)))).extracting(ArtifactRecord::id).containsExactly(id);
        registry.release(id, ReleaseReason.EXPIRED);
        assertThat(registry.budget().chargedBytes()).isZero();
    }

    @Test
    @DisplayName("RC-B-091 / S3-AR-08: a staged file keeps its public UUID, owner and key, has no target and no path, the registry port finds it by owner and key (the retry of a begin gets the same UUID), and the same owner and key (or the same UUID) cannot be reserved twice")
    void aStagedFileIsBoundToItsOwnerAndKey() {
        ArtifactUuid uuid = fixtures.nextUuid();
        String key = "opaque-upload-key-0001";
        ArtifactId id = fixtures.reservedId(registry.reserve(fixtures.staged("verified-owner", key, uuid, 4), fixtures.at()));

        ArtifactRecord record = registry.find(id).orElseThrow();
        assertThat(uuid.text()).matches(Pattern.compile("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"));
        assertThat(record.spec().origin()).isEqualTo(new ArtifactOrigin.Staged(uuid, new OwnerId("verified-owner"), key));
        assertThat(record.spec().destination()).isEqualTo(new ArtifactDestination.Unassigned());
        assertThat(record.spec().fileName().value()).isEqualTo("한글😀.bin");
        assertThat(registry.findStaged(uuid)).contains(record);
        assertThat(registry.findStagedByKey(new OwnerId("verified-owner"), key)).contains(record);

        assertRefused(() -> registry.reserve(fixtures.staged("verified-owner", key, fixtures.nextUuid(), 4), fixtures.at()), RequestErrorCode.OPERATION_KEY_CONFLICT);
        assertRefused(() -> registry.reserve(fixtures.staged("verified-owner", "opaque-upload-key-0002", uuid, 4), fixtures.at()),
            RequestErrorCode.OPERATION_KEY_CONFLICT);
        ArtifactUuid otherUuid = fixtures.nextUuid();
        ArtifactId other = fixtures.reservedId(registry.reserve(fixtures.staged("other-owner", key, otherUuid, 4), fixtures.at()));
        assertThat(other).isNotEqualTo(id);
        assertThat(registry.findStagedByKey(new OwnerId("other-owner"), key).orElseThrow().id()).isEqualTo(other);
        assertThat(registry.findStagedByKey(new OwnerId("verified-owner"), key).orElseThrow().id()).isEqualTo(id);

        List<StagedAction> actions = registry.actions(id);
        assertThat(actions).isEmpty();
        assertThatThrownBy(() -> actions.add(null)).isInstanceOf(UnsupportedOperationException.class);
        assertThat(registry.actions(id)).isEmpty();
    }

    @Test
    @DisplayName("RC-B-092: a staged operation key with a trailing CR or LF is refused at the store, a digest or UUID with one is no value, and nothing is stored")
    void lineBreakSuffixesAreRefused() {
        ArtifactUuid uuid = fixtures.nextUuid();
        for (String suffix : List.of("\r", "\n", "\r\n")) {
            assertRefused(() -> registry.reserve(fixtures.staged("verified-owner", "valid-operation-key" + suffix, fixtures.nextUuid(), 4), fixtures.at()),
                ArtifactErrorCode.INVALID_OPERATION_KEY);
            assertThatThrownBy(() -> new Digest("a".repeat(64) + suffix)).isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> ArtifactUuid.parse(uuid.text() + suffix)).isInstanceOf(IllegalArgumentException.class);
        }
        assertThat(registry.holding()).isEmpty();
        assertThat(registry.budget().chargedBytes()).isZero();

        ArtifactId id = fixtures.reservedId(registry.reserve(fixtures.staged("verified-owner", "valid-operation-key", uuid, 4), fixtures.at()));
        assertThat(registry.findStaged(uuid).orElseThrow().id()).isEqualTo(id);
    }

    @Test
    @DisplayName("RC-B-094: an empty file charges one byte, and a file whose expiry equals the instant is listed as expired")
    void anEmptyFileChargesOneByteAndTheExpiryIsInclusive() {
        ArtifactId empty = fixtures.readyArtifact(registry, fixtures.upload(0), new byte[0]);

        assertThat(registry.budget().chargedBytes()).isEqualTo(1);
        ArtifactRecord record = registry.find(empty).orElseThrow();
        // One microsecond before: the column is TIMESTAMP(6), and a PostgreSQL parameter of one nanosecond less is rounded to the same microsecond (S2-DB-13).
        assertThat(registry.expired(record.expiresAt().minusNanos(1_000))).isEmpty();
        assertThat(registry.expired(record.expiresAt())).extracting(ArtifactRecord::id).containsExactly(empty);
        registry.release(empty, ReleaseReason.EXPIRED);
        assertThat(registry.budget().chargedBytes()).isZero();
    }

    @Test
    @DisplayName("RC-B-095: a consumed staged file keeps its size and digest, charges one byte once, answers a repeated completion with the same row and refuses another reason")
    void theConsumeTombstoneChargesOneByte() {
        byte[] bytes = fixtures.bytes(4, 5);
        ArtifactId moved = fixtures.readyArtifact(registry, fixtures.stagedFile(4), bytes);
        ArtifactId removed = fixtures.readyArtifact(registry, fixtures.stagedFile(4), bytes);
        assertThat(registry.budget().chargedBytes()).isEqualTo(8);

        ArtifactRecord consuming = registry.beginConsume(moved, ConsumeReason.MOVED);
        assertThat(consuming.state()).isEqualTo(ArtifactState.CONSUMING);
        assertThat(consuming.consumption()).as("S3-AR-09: the reason is recorded when the use starts").isEqualTo(new ConsumeState.Consuming(ConsumeReason.MOVED));
        assertRefused(() -> registry.beginConsume(moved, ConsumeReason.MOVED), ArtifactErrorCode.STAGED_FILE_CONSUMED);
        assertRefused(() -> registry.beginDelete(moved), ArtifactErrorCode.ARTIFACT_BUSY);
        ArtifactRecord done = registry.completeConsume(moved, ConsumeReason.MOVED);

        assertThat(done.state()).isEqualTo(ArtifactState.CONSUMED);
        assertThat(done.consumption()).isEqualTo(new ConsumeState.ConsumedBecause(ConsumeReason.MOVED));
        assertThat(done.receivedBytes()).isEqualTo(4);
        assertThat(done.spec().sizeBytes()).isEqualTo(4);
        assertThat(done.content()).isEqualTo(new ContentDigest.Sealed(fixtures.digest(bytes)));
        assertThat(registry.completeConsume(moved, ConsumeReason.MOVED)).isEqualTo(done);
        assertRefused(() -> registry.completeConsume(moved, ConsumeReason.REMOVED), ArtifactErrorCode.STAGED_FILE_CONSUMED);
        assertRefused(() -> registry.beginConsume(moved, ConsumeReason.MOVED), ArtifactErrorCode.STAGED_FILE_CONSUMED);
        assertThat(registry.budget().chargedBytes()).isEqualTo(4 + 1);

        registry.beginConsume(removed, ConsumeReason.REMOVED);
        registry.completeConsume(removed, ConsumeReason.REMOVED);
        assertThat(registry.budget().chargedBytes()).isEqualTo(2);
        assertThat(registry.holding()).isEmpty();
        assertThat(registry.expired(ArtifactFixtures.T0.plus(Duration.ofMinutes(11)))).extracting(ArtifactRecord::id).containsExactlyInAnyOrder(moved, removed);
        registry.release(moved, ReleaseReason.CONSUMED);
        registry.release(removed, ReleaseReason.CONSUMED);
        assertThat(registry.budget().chargedBytes()).isZero();
    }

    @Test
    @DisplayName("RC-B-095: a staging or an already marked-for-deletion file cannot be consumed, and a state that is not CONSUMING cannot be completed")
    void consumeNeedsAReadyFile() {
        ArtifactId staging = fixtures.reservedId(registry.reserve(fixtures.stagedFile(4), fixtures.at()));
        ArtifactId ready = fixtures.readyArtifact(registry, fixtures.stagedFile(4), fixtures.bytes(4, 1));
        registry.beginDelete(ready);

        assertRefused(() -> registry.beginConsume(staging, ConsumeReason.REMOVED), ArtifactErrorCode.ARTIFACT_NOT_READY);
        assertRefused(() -> registry.beginConsume(ready, ConsumeReason.REMOVED), ArtifactErrorCode.ARTIFACT_NOT_READY);
        assertRefused(() -> registry.completeConsume(staging, ConsumeReason.MOVED), ArtifactErrorCode.ARTIFACT_CHANGED);
    }

    @Test
    @DisplayName("RC-B-583: the Windows path and the POSIX path, the target id, the revision and the binding of a transfer are kept as given; an invalid Windows path is no value at all")
    void bothPathSyntaxesAreKept() {
        byte[] bytes = {0, (byte) 255, 13, 10, (byte) 128};
        WindowsRemotePath windowsPath = new WindowsRemotePath("C:\\Users\\x\\file.bin");
        ArtifactId windows = fixtures.readyArtifact(registry, fixtures.upload(5, windowsPath, new TargetId("windows")), bytes);
        ArtifactId posix = fixtures.readyArtifact(registry, fixtures.upload(5, new PosixRemotePath("/tmp/a b/file.bin"), new TargetId("linux")), bytes);

        ArtifactDestination.Assigned windowsDestination = (ArtifactDestination.Assigned) registry.find(windows).orElseThrow().spec().destination();
        assertThat(windowsDestination.path()).isEqualTo(windowsPath);
        assertThat(windowsDestination.targetId()).isEqualTo(new TargetId("windows"));
        assertThat(windowsDestination.targetRevision()).isEqualTo(TargetRevision.of("a".repeat(64)));
        assertThat(windowsDestination.binding()).isEqualTo(BindingKind.BOUND);
        ArtifactDestination.Assigned posixDestination = (ArtifactDestination.Assigned) registry.find(posix).orElseThrow().spec().destination();
        assertThat(posixDestination.path()).isEqualTo(new PosixRemotePath("/tmp/a b/file.bin"));
        assertThat(posixDestination.targetId()).isEqualTo(new TargetId("linux"));

        long charged = registry.budget().chargedBytes();
        assertThatThrownBy(() -> new WindowsRemotePath("C:/file:stream")).isInstanceOf(IllegalArgumentException.class);
        assertThat(registry.budget().chargedBytes()).isEqualTo(charged);
        assertThat(registry.holding()).hasSize(2);
    }

    @Test
    @DisplayName("RC-A-165 (store half): a download keeps the target, revision and binding it was bound to and its one hour retention; an upload keeps overwrite mode, elevation and protocol")
    void theBindingFieldsAreKept() {
        ArtifactId upload = fixtures.readyArtifact(registry, fixtures.upload(1), new byte[] {1});
        ArtifactId download = fixtures.readyArtifact(registry, fixtures.download(1), new byte[] {1});

        ArtifactSpec uploadSpec = registry.find(upload).orElseThrow().spec();
        assertThat(uploadSpec.overwrite()).isEqualTo(OverwriteMode.REPLACE);
        assertThat(uploadSpec.elevation()).isEqualTo(Elevation.NONE);
        assertThat(uploadSpec.protocol()).isEqualTo(UploadProtocol.MCP_JSON_V1);
        assertThat(uploadSpec.timeToLive()).isEqualTo(ArtifactLimits.UPLOAD_TTL);
        ArtifactSpec downloadSpec = registry.find(download).orElseThrow().spec();
        assertThat(downloadSpec.protocol()).isEqualTo(UploadProtocol.UNSPECIFIED);
        assertThat(downloadSpec.timeToLive()).isEqualTo(ArtifactFixtures.ONE_HOUR);
        ArtifactDestination.Assigned destination = (ArtifactDestination.Assigned) downloadSpec.destination();
        assertThat(destination.targetId()).isEqualTo(new TargetId("alpha"));
        assertThat(destination.targetRevision()).isEqualTo(TargetRevision.of("a".repeat(64)));
        assertThat(destination.binding()).isEqualTo(BindingKind.BOUND);
    }

    @Test
    @DisplayName("staged actions: one use per (artifact, operation key), the state moves forward only, an unknown artifact is refused, and the release removes the actions")
    void stagedActionsMoveForwardOnly() {
        ArtifactId id = fixtures.reservedId(registry.reserve(fixtures.stagedFile(0), fixtures.at()));
        StagedAction action = new StagedAction(id, "action-key-0001", new RequestKey("request-key-000001"), fixtures.digest(new byte[] {1}), OPERATION_A,
            StagedActionKind.COPY, StagedActionState.RESERVED, new TargetId("alpha"), TargetRevision.of("b".repeat(64)), new PosixRemotePath("/tmp/out.bin"),
            OverwriteMode.FAIL_IF_EXISTS, Elevation.SUDO);

        registry.addAction(action);
        assertRefused(() -> registry.addAction(action), ArtifactErrorCode.OPAQUE_ACTION_CONFLICT);
        StagedAction orphan = new StagedAction(new ArtifactId("1".repeat(48)), "action-key-0001", action.requestKey(), action.inputDigest(), OPERATION_A,
            StagedActionKind.MOVE, StagedActionState.RESERVED, action.targetId(), action.targetRevision(), action.remotePath(), OverwriteMode.REPLACE, Elevation.NONE);
        assertRefused(() -> registry.addAction(orphan), ArtifactErrorCode.ARTIFACT_NOT_FOUND);
        assertThat(registry.actions(id)).containsExactly(action);

        registry.updateAction(id, "action-key-0001", StagedActionState.SUBMITTED);
        registry.updateAction(id, "action-key-0001", StagedActionState.SUBMITTED);
        registry.updateAction(id, "action-key-0001", StagedActionState.SETTLED);
        assertThat(registry.actions(id)).extracting(StagedAction::state).containsExactly(StagedActionState.SETTLED);
        assertRefused(() -> registry.updateAction(id, "action-key-0001", StagedActionState.SUBMITTED), ArtifactErrorCode.OPAQUE_ACTION_CONFLICT);
        assertRefused(() -> registry.updateAction(id, "action-key-9999", StagedActionState.SUBMITTED), ArtifactErrorCode.ARTIFACT_NOT_FOUND);

        registry.release(id, ReleaseReason.ABANDONED);
        assertThat(registry.actions(id)).isEmpty();
    }

    @Test
    @DisplayName("deletion: an artifact marked for deletion still charges its bytes until it is released, and it is not in the listing of expired artifacts")
    void aDeletingArtifactStillCharges() {
        ArtifactId id = fixtures.readyArtifact(registry, fixtures.upload(4), fixtures.bytes(4, 1));
        registry.beginDelete(id);

        assertThat(registry.budget().chargedBytes()).isEqualTo(4);
        assertThat(registry.expired(ArtifactFixtures.T0.plus(Duration.ofHours(5)))).isEmpty();
        assertThat(registry.holding()).extracting(ArtifactRecord::state).containsExactly(ArtifactState.DELETING);
    }

    /**
     * The refused call runs in its own savepoint: a refusal that comes from a violated constraint aborts the transaction on PostgreSQL (SQL state 25P02 for every later
     * statement), and any refusal from a {@code @Transactional} method marks the joined transaction rollback-only. A caller that goes on after a refusal scopes the call in a
     * nested transaction, whose rollback to the savepoint clears both (S2-DB-17).
     */
    private void assertRefused(Runnable call, ErrorCode code) {
        assertThatThrownBy(() -> savepoints.run(call)).isInstanceOfSatisfying(RequestRefusedException.class, e -> assertThat(e.code()).isEqualTo(code));
    }
}
