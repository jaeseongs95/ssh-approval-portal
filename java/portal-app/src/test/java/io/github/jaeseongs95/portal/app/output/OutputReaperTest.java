package io.github.jaeseongs95.portal.app.output;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.app.storage.DiskSpace;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.app.storage.ProtectionCheck;
import io.github.jaeseongs95.portal.app.storage.ReapFixtures;
import io.github.jaeseongs95.portal.app.storage.ReapGate;
import io.github.jaeseongs95.portal.app.storage.ReapPermission;
import io.github.jaeseongs95.portal.app.storage.ReapReport;
import io.github.jaeseongs95.portal.app.storage.StorageArea;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.OperationId;

/**
 * The reap of the command outputs (RC-A-173, RC-B-004, S3-UC-06): an expired output is removed with its bytes first and its row second; while a maintenance reservation
 * holds the installation, or while the protection of a store fails, nothing is deleted and the expired bytes stay as they were.
 */
class OutputReaperTest {

    private static final Instant NOW = Instant.parse("2026-11-12T01:00:00Z");

    private final ReapFixtures.Maintenance maintenance = new ReapFixtures.Maintenance();
    private final ReapFixtures.Protection protection = new ReapFixtures.Protection();
    private final Outputs outputs = new Outputs();
    private final OutputReaper reaper = new OutputReaper(outputs, outputs, new ReapGate(maintenance, protection), Clock.fixed(NOW, ZoneOffset.UTC));

    @Test
    @DisplayName("S3-UC-06: an expired output is removed, bytes before row; one that has not expired stays")
    void anExpiredOutputIsRemoved() {
        outputs.add(id(1), NOW.minusSeconds(1));
        outputs.add(id(2), NOW.plusSeconds(60));

        assertThat(reaper.reap()).isEqualTo(new ReapReport.Reaped(1, 0));

        assertThat(outputs.events).containsExactly("bytes " + id(1).value(), "row " + id(1).value());
    }

    @Test
    @DisplayName("S3-UC-06 / RC-A-173: while maintenance holds the installation nothing is deleted, and the reap resumes after the release")
    void maintenanceHoldsTheReapBack() {
        outputs.add(id(1), NOW.minusSeconds(1));
        maintenance.occupy(true);

        assertThat(reaper.reap()).isEqualTo(new ReapReport.Suspended(ReapPermission.SuspendReason.MAINTENANCE));
        assertThat(outputs.events).isEmpty();

        maintenance.occupy(false);
        assertThat(reaper.reap()).isEqualTo(new ReapReport.Reaped(1, 0));
    }

    @Test
    @DisplayName("S3-UC-06 / RC-B-004: a protection that fails keeps the expired output: no byte and no row is deleted")
    void aFailingProtectionKeepsTheExpiredOutput() {
        outputs.add(id(1), NOW.minusSeconds(1));
        protection.answer(new ProtectionCheck.Unprotected(StorageArea.OUTPUTS, new IOException("open to others")));

        assertThat(reaper.reap()).isEqualTo(new ReapReport.Suspended(ReapPermission.SuspendReason.PROTECTION_FAILED));
        assertThat(outputs.events).isEmpty();
    }

    @Test
    @DisplayName("S3-UC-06: an output whose bytes cannot be deleted is counted and kept, and the others are still removed")
    void anOutputThatCannotBeRemovedDoesNotStopTheRun() {
        outputs.add(id(1), NOW.minusSeconds(2));
        outputs.add(id(2), NOW.minusSeconds(1));
        outputs.failOn = id(1);

        assertThat(reaper.reap()).isEqualTo(new ReapReport.Reaped(1, 1));
        assertThat(outputs.events).containsExactly("bytes " + id(2).value(), "row " + id(2).value());
    }

    private OutputId id(int number) {
        return new OutputId(String.format("%048x", number));
    }

    /** One class stands for both ports of the output store: it lists the expired manifests and records the order of the deletions. */
    private static final class Outputs implements OutputManifestStore, OutputPayloadStore {

        private final Map<OutputId, Instant> expiry = new java.util.LinkedHashMap<>();
        final List<String> events = new ArrayList<>();
        OutputId failOn;

        void add(OutputId id, Instant expiresAt) {
            expiry.put(id, expiresAt);
        }

        @Override
        public List<OutputManifest> expired(Instant now) {
            return expiry.entrySet().stream().filter(entry -> !entry.getValue().isAfter(now)).map(entry -> new OutputManifest(entry.getKey(),
                new OutputBinding(new OperationId("c".repeat(48)), new OutputTarget.Unbound()), OutputState.READY, entry.getValue(), 1, 1, new OutputFormats(Map.of()),
                new StreamInfo.NoStream(), 1)).toList();
        }

        @Override
        public void delete(OutputId id) {
            if (id.equals(failOn)) {
                throw new IllegalStateException("the file is locked");
            }
            if (events.contains("bytes " + id.value())) {
                events.add("row " + id.value());
                expiry.remove(id);
            } else {
                events.add("bytes " + id.value());
            }
        }

        @Override
        public OutputLookup find(OutputId id, Instant now) {
            throw new IllegalStateException("not used");
        }

        @Override
        public OutputReservation reserve(OutputBinding binding, long expectedBytes, Instant at) {
            throw new IllegalStateException("not used");
        }

        @Override
        public OutputManifest recordStream(OutputId id, StreamInfo stream) {
            throw new IllegalStateException("not used");
        }

        @Override
        public OutputManifest markReady(OutputId id, OutputFormats formats, long sizeBytes) {
            throw new IllegalStateException("not used");
        }

        @Override
        public void markUnavailable(OutputId id, Instant expiresAt) {
            throw new IllegalStateException("not used");
        }

        @Override
        public OutputBudget budget() {
            throw new IllegalStateException("not used");
        }

        @Override
        public List<OutputManifest> inState(OutputState state) {
            throw new IllegalStateException("not used");
        }

        @Override
        public long append(OutputId id, StreamFrame frame) {
            throw new IllegalStateException("not used");
        }

        @Override
        public OutputFormats finish(OutputId id, byte[] json, byte[] text) {
            throw new IllegalStateException("not used");
        }

        @Override
        public PayloadRead openFormat(OutputId id, OutputFormat format, FormatSpan span) {
            throw new IllegalStateException("not used");
        }

        @Override
        public PayloadRead openStream(OutputId id) {
            throw new IllegalStateException("not used");
        }

        @Override
        public Digest streamDigest(OutputId id) {
            throw new IllegalStateException("not used");
        }

        @Override
        public long retainedBytes(OutputId id) {
            throw new IllegalStateException("not used");
        }

        @Override
        public void quarantine(OutputId id) {
            throw new IllegalStateException("not used");
        }

        @Override
        public Set<OutputId> stored() {
            throw new IllegalStateException("not used");
        }

        @Override
        public DiskSpace usable() {
            throw new IllegalStateException("not used");
        }
    }
}
