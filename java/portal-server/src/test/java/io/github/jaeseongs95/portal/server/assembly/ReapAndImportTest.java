package io.github.jaeseongs95.portal.server.assembly;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.Channels;
import java.nio.channels.ReadableByteChannel;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import io.github.jaeseongs95.portal.app.artifact.ArtifactDestination;
import io.github.jaeseongs95.portal.app.artifact.ArtifactDirection;
import io.github.jaeseongs95.portal.app.artifact.ArtifactImporter;
import io.github.jaeseongs95.portal.app.artifact.ArtifactOrigin;
import io.github.jaeseongs95.portal.app.artifact.ArtifactPayloadStore;
import io.github.jaeseongs95.portal.app.artifact.ArtifactPinning;
import io.github.jaeseongs95.portal.app.artifact.ArtifactReaper;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRegistry;
import io.github.jaeseongs95.portal.app.artifact.ArtifactReservation;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRetention;
import io.github.jaeseongs95.portal.app.artifact.ArtifactSpec;
import io.github.jaeseongs95.portal.app.artifact.ChunkDigest;
import io.github.jaeseongs95.portal.app.artifact.ImportResult;
import io.github.jaeseongs95.portal.app.file.OutputStreamImport;
import io.github.jaeseongs95.portal.app.maintenance.MaintenanceStore;
import io.github.jaeseongs95.portal.app.maintenance.OwnerHash;
import io.github.jaeseongs95.portal.app.output.OutputId;
import io.github.jaeseongs95.portal.app.output.OutputPayloadStore;
import io.github.jaeseongs95.portal.app.output.StreamFrame;
import io.github.jaeseongs95.portal.app.output.StreamKind;
import io.github.jaeseongs95.portal.app.remote.PayloadSource;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.app.storage.ReapPermission;
import io.github.jaeseongs95.portal.app.storage.ReapReport;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.file.FileName;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.operation.Elevation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.operation.UploadProtocol;
import io.github.jaeseongs95.portal.domain.id.OperationId;

/**
 * The reaper of the artifacts on the real store and real files (S3-UC-06: a maintenance reservation holds the reap back, RC-A-173), the release of a pinned artifact when its
 * operation settled (S3-AR-07), and the import of a stream into an artifact (RC-A-182, RC-A-183, S3-AR-06): the capacity is reserved before the source is opened, and a
 * failure of any kind leaves no file, no row and no charge.
 */
@AssemblyTest
class ReapAndImportTest {

    private static final Sha256Digester DIGEST = new Sha256Digester();
    private static final OwnerHash OWNER = new OwnerHash("b".repeat(64));

    private final ArtifactReaper reaper;
    private final ArtifactPinning pinning;
    private final ArtifactImporter importer;
    private final OutputStreamImport outputImport;
    private final ArtifactRegistry registry;
    private final ArtifactPayloadStore payloads;
    private final OutputPayloadStore outputs;
    private final MaintenanceStore maintenance;
    private final JdbcTemplate jdbc;
    private final Clock clock;

    ReapAndImportTest(ArtifactReaper reaper, ArtifactPinning pinning, ArtifactImporter importer, OutputStreamImport outputImport, ArtifactRegistry registry,
                      ArtifactPayloadStore payloads, OutputPayloadStore outputs, MaintenanceStore maintenance, JdbcTemplate jdbc, Clock clock) {
        this.reaper = reaper;
        this.pinning = pinning;
        this.importer = importer;
        this.outputImport = outputImport;
        this.registry = registry;
        this.payloads = payloads;
        this.outputs = outputs;
        this.maintenance = maintenance;
        this.jdbc = jdbc;
        this.clock = clock;
    }

    @BeforeEach
    void clean() {
        jdbc.update("DELETE FROM staged_action");
        jdbc.update("DELETE FROM artifact_chunk");
        jdbc.update("DELETE FROM artifact");
        jdbc.update("DELETE FROM maintenance_release");
        jdbc.update("DELETE FROM maintenance_reservation");
    }

    // ---- reaper ----

    @Test
    @DisplayName("S3-UC-06 / RC-A-173: while a maintenance reservation holds the installation an expired artifact keeps its bytes, its row and its charge; after the release the reap removes all three")
    void maintenanceHoldsTheReapBack() {
        byte[] bytes = bytes(300, 1);
        ArtifactId id = expiredArtifact(bytes);
        assertThat(registry.budget().chargedBytes()).isEqualTo(300);
        maintenance.reserve(OWNER);

        ReapReport held = reaper.reap();
        maintenance.release(OWNER);

        assertThat(held).isEqualTo(new ReapReport.Suspended(ReapPermission.SuspendReason.MAINTENANCE));
        assertThat(payloads.stored()).as("the bytes are untouched").contains(id);
        assertThat(registry.find(id)).as("the row is untouched").isPresent();
        assertThat(registry.budget().chargedBytes()).as("the accounting is untouched").isEqualTo(300);

        assertThat(reaper.reap()).isEqualTo(new ReapReport.Reaped(1, 0));
        assertThat(payloads.stored()).doesNotContain(id);
        assertThat(registry.find(id)).isEmpty();
        assertThat(registry.budget().chargedBytes()).isZero();
    }

    @Test
    @DisplayName("S3-AR-07: a pinned artifact is never reaped; when its operation settled it is unpinned and the next reap removes it, but an unknown operation keeps it pinned")
    void aPinnedArtifactIsReapedOnlyAfterItsOperationSettled() {
        ArtifactId id = expiredArtifact(bytes(100, 2));
        registry.submit(id, new OperationId("d".repeat(48)));

        assertThat(reaper.reap()).as("pinned by the operation").isEqualTo(new ReapReport.Reaped(0, 0));
        pinning.operationSettled(id, OperationState.UNKNOWN);
        assertThat(reaper.reap()).as("unknown keeps the pin").isEqualTo(new ReapReport.Reaped(0, 0));
        pinning.operationSettled(id, OperationState.RUNNING);
        assertThat(reaper.reap()).as("an operation that runs keeps the pin").isEqualTo(new ReapReport.Reaped(0, 0));

        pinning.operationSettled(id, OperationState.COMPLETED);
        pinning.operationSettled(id, OperationState.COMPLETED);

        assertThat(reaper.reap()).isEqualTo(new ReapReport.Reaped(1, 0));
        assertThat(registry.find(id)).isEmpty();
    }

    // ---- import ----

    @Test
    @DisplayName("RC-A-182: the capacity is reserved before the source is opened, the bytes are counted and hashed, and the artifact is ready with the digest of exactly those bytes")
    void theCapacityIsReservedBeforeTheSourceIsOpened() {
        byte[] bytes = bytes(1200, 3);
        AtomicInteger chargedWhenOpened = new AtomicInteger(-1);

        ImportResult result = importer.importStream(spec(bytes.length), () -> {
            chargedWhenOpened.set((int) registry.budget().chargedBytes());
            return source(bytes).open();
        }, DIGEST.digest(bytes));

        assertThat(chargedWhenOpened.get()).as("reserved before the first byte is read").isEqualTo(1200);
        assertThat(result).isInstanceOfSatisfying(ImportResult.Imported.class, imported -> {
            assertThat(imported.artifact().content()).isEqualTo(new io.github.jaeseongs95.portal.app.artifact.ContentDigest.Sealed(DIGEST.digest(bytes)));
            assertThat(payloads.length(imported.artifact().id())).isEqualTo(1200);
        });
        assertThat(registry.budget().chargedBytes()).isEqualTo(1200);
    }

    @Test
    @DisplayName("RC-A-182 / S3-AR-02: an import that the budget refuses never opens its source and answers the refusal with its numbers")
    void anImportThatTheBudgetRefusesNeverOpensItsSource() {
        for (int i = 0; i < 10; i++) {
            assertThat(registry.reserve(spec(9_500), clock.instant())).isInstanceOf(ArtifactReservation.Reserved.class);
        }
        AtomicInteger opened = new AtomicInteger();

        ImportResult result = importer.importStream(spec(9_000), () -> {
            opened.incrementAndGet();
            return source(bytes(9_000, 1)).open();
        });

        assertThat(result).isInstanceOfSatisfying(ImportResult.Refused.class, refused -> assertThat(refused.refusal().code()).isEqualTo(ExecutionErrorCode.ARTIFACT_QUOTA));
        assertThat(opened.get()).isZero();
    }

    @Test
    @DisplayName("RC-A-183: a source that cannot be opened, ends early, gives too much, breaks in the middle or has another digest fails the import and leaves no file, no row and no charge")
    void everyFailureLeavesNothingBehind() {
        PayloadSource unopenable = () -> {
            throw new IllegalStateException("the source is gone");
        };
        PayloadSource breaking = () -> new PayloadRead(new BreakingChannel(bytes(100, 1)), 100);

        assertThat(importer.importStream(spec(100), unopenable)).isEqualTo(new ImportResult.Failed(ImportResult.Reason.SOURCE_FAILED));
        assertThat(importer.importStream(spec(100), breaking)).isEqualTo(new ImportResult.Failed(ImportResult.Reason.SOURCE_FAILED));
        assertThat(importer.importStream(spec(3), source(bytes(2, 1)))).as("declared 3, delivered 2").isEqualTo(new ImportResult.Failed(ImportResult.Reason.SIZE_MISMATCH));
        assertThat(importer.importStream(spec(4), source(bytes(5, 1)))).as("declared 4, delivered 5").isEqualTo(new ImportResult.Failed(ImportResult.Reason.SIZE_MISMATCH));
        assertThat(importer.importStream(spec(5), source(bytes(5, 1)), DIGEST.digest(bytes(5, 2)))).isEqualTo(new ImportResult.Failed(ImportResult.Reason.DIGEST_MISMATCH));

        assertThat(registry.holding()).isEmpty();
        assertThat(registry.budget().chargedBytes()).isZero();
    }

    @Test
    @DisplayName("S3-AR-06 / RC-A-182: the spool of an output is imported through openStream and compared with streamDigest; a declared size that is not the spool's fails the import and leaves nothing")
    void theSpoolOfAnOutputIsImportedAndCompared() {
        OutputId output = new OutputId("7".repeat(48));
        try {
            outputs.append(output, new StreamFrame(StreamKind.STDOUT, "hello".getBytes(StandardCharsets.UTF_8)));
            long size = 5 + 5;

            ImportResult wrong = outputImport.importSpool(output, spec(size + 1));
            assertThat(wrong).isEqualTo(new ImportResult.Failed(ImportResult.Reason.SIZE_MISMATCH));
            assertThat(registry.holding()).isEmpty();

            ImportResult result = outputImport.importSpool(output, spec(size));
            assertThat(result).isInstanceOfSatisfying(ImportResult.Imported.class,
                imported -> assertThat(imported.artifact().content()).isEqualTo(new io.github.jaeseongs95.portal.app.artifact.ContentDigest.Sealed(outputs.streamDigest(output))));
        } finally {
            outputs.delete(output);
        }
    }

    // ---- helpers ----

    private byte[] bytes(int length, int fill) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, (byte) fill);
        return bytes;
    }

    private PayloadSource source(byte[] bytes) {
        return () -> new PayloadRead(Channels.newChannel(new ByteArrayInputStream(bytes)), bytes.length);
    }

    private ArtifactSpec spec(long size) {
        return new ArtifactSpec(ArtifactDirection.UPLOAD, new FileName("import.bin"), size, new ArtifactOrigin.Transfer(), new ArtifactDestination.Unassigned(),
            OverwriteMode.REPLACE, Elevation.NONE, UploadProtocol.UNSPECIFIED, ArtifactRetention.RELEASABLE, Duration.ofMinutes(10));
    }

    /** A ready artifact whose time is already over (a time-to-live of one microsecond, the finest the TIMESTAMP(6) columns keep): it is for the reaper to remove. */
    private ArtifactId expiredArtifact(byte[] bytes) {
        ArtifactSpec expired = new ArtifactSpec(ArtifactDirection.UPLOAD, new FileName("old.bin"), bytes.length, new ArtifactOrigin.Transfer(), new ArtifactDestination.Unassigned(),
            OverwriteMode.REPLACE, Elevation.NONE, UploadProtocol.UNSPECIFIED, ArtifactRetention.RELEASABLE, Duration.ofNanos(1_000));
        ArtifactId id = ((ArtifactReservation.Reserved) registry.reserve(expired, clock.instant())).id();
        payloads.append(id, 0, bytes);
        registry.append(id, 0, new ChunkDigest(bytes.length, DIGEST.digest(bytes)));
        registry.markReady(id, DIGEST.digest(bytes));
        return id;
    }

    /** A channel that delivers its first half and then breaks, like a connection that drops in the middle of the body. */
    private static final class BreakingChannel implements ReadableByteChannel {

        private final byte[] bytes;
        private boolean delivered;

        BreakingChannel(byte[] bytes) {
            this.bytes = bytes;
        }

        @Override
        public int read(ByteBuffer target) throws IOException {
            if (delivered) {
                throw new IOException("connection reset");
            }
            delivered = true;
            int half = bytes.length / 2;
            target.put(bytes, 0, half);
            return half;
        }

        @Override
        public boolean isOpen() {
            return true;
        }

        @Override
        public void close() {
            // nothing to release
        }
    }
}
