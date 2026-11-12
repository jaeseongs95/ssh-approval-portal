package io.github.jaeseongs95.portal.store.output;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.channels.Channels;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import javax.sql.DataSource;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.context.annotation.Import;

import io.github.jaeseongs95.portal.app.output.OutputBinding;
import io.github.jaeseongs95.portal.app.output.OutputFormat;
import io.github.jaeseongs95.portal.app.output.OutputFormats;
import io.github.jaeseongs95.portal.app.output.OutputId;
import io.github.jaeseongs95.portal.app.output.OutputLookup;
import io.github.jaeseongs95.portal.app.output.OutputManifest;
import io.github.jaeseongs95.portal.app.output.OutputReservation;
import io.github.jaeseongs95.portal.app.output.OutputState;
import io.github.jaeseongs95.portal.app.output.StreamFrame;
import io.github.jaeseongs95.portal.app.output.StreamInfo;
import io.github.jaeseongs95.portal.app.output.StreamKind;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.store.StoreTest;
import io.github.jaeseongs95.portal.store.output.OutputFiles.PayloadKind;

/**
 * The accounting of the output store (charge, retention, restart) across the manifest store, the payload store and the start-up check, on the test database and a
 * temporary folder. A restart is a second {@link OutputWorld} over the same folder and database. Time is a fixed clock plus offsets; the retention is 50 ms.
 *
 * <p>What these cases do not cover belongs to a use case of stage 3 and is deferred, case by case, in the display names: the result JSON and the failure details of
 * a capture (A-489, A-494, A-495), the settlement of an operation (A-498), the sanitising of exit metadata (A-499), reading the stream with cursors, events and
 * authorization callbacks (A-496, A-501, A-503, A-504, A-505), the page assembly of a read (A-507, A-511) and the maintenance guard that decides whether to reap
 * (A-492, A-506, A-509).
 */
@StoreTest
@Import({OutputMapper.class, OutputWorldFactory.class})
class OutputAccountingTest {

    private static final Instant T0 = Clock.fixed(Instant.parse("2026-11-12T00:00:00Z"), ZoneOffset.UTC).instant();
    /** Retention 50 ms, one output 1024 bytes, budget for eight of them. */
    private static final OutputLimits LIMITS = new OutputLimits(Duration.ofMillis(50), 1024, 8192, 1000, 0L);
    /** The same with a budget for one output. */
    private static final OutputLimits ONE = new OutputLimits(Duration.ofMillis(50), 1024, 1024, 1000, 0L);

    private final OutputWorldFactory factory;
    private final OutputFixture fixture;

    OutputAccountingTest(OutputWorldFactory factory, DataSource dataSource) {
        this.factory = factory;
        this.fixture = new OutputFixture(dataSource);
    }

    private byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private byte[] readAll(PayloadRead read) throws IOException {
        try (read) {
            return Channels.newInputStream(read.channel()).readAllBytes();
        }
    }

    private List<CommandOutputRow> allRows(OutputWorld w) {
        List<CommandOutputRow> all = new ArrayList<>();
        w.rows.findAll().forEach(all::add);
        return all;
    }

    private void assertChargeAcrossRestart(Path folder, OutputWorld w, OutputId id, long expected) {
        assertThat(w.charge(id)).isEqualTo(expected);
        OutputWorld restarted = factory.create(folder, LIMITS);
        restarted.startup.reconcile(T0);
        assertThat(restarted.charge(id)).isEqualTo(expected);
        assertThat(restarted.row(id).state()).isEqualTo(OutputState.UNAVAILABLE);
    }

    @Test
    @DisplayName("RC-A-488: more than eight failed reservations release the charge of their empty payload without losing their rows or the ready output; "
        + "a restart keeps it so")
    void failedReservationsReleaseTheirCharge(@TempDir Path folder) throws IOException {
        OutputWorld w = factory.create(folder, LIMITS);
        OutputBinding binding = fixture.unbound();
        OutputId ready = w.reserve(binding, 1024, T0);
        w.manifests.markReady(ready, w.payloads.finish(ready, utf8("{}"), utf8("retained output")), 17);
        OutputLookup readyBefore = w.manifests.find(ready, T0);
        byte[] readyBytes = Files.readAllBytes(w.file(ready, PayloadKind.OUT));

        List<OutputId> failed = new ArrayList<>();
        for (int i = 0; i < 12; i++) {
            OutputId id = w.reserve(binding, 1024, T0);
            assertThat(w.charge(id)).as("work in flight reserves its maximum").isEqualTo(1024L);
            w.manifests.markUnavailable(id, T0.plusMillis(50));
            assertThat(w.charge(id)).isZero();
            assertThat(w.row(id).state()).isEqualTo(OutputState.UNAVAILABLE);
            assertThat(w.row(id).executionId()).as("the binding is kept").isEqualTo(binding.executionId().value());
            assertThat(w.payloads.retainedBytes(id)).isZero();
            assertThat(w.manifests.find(id, T0)).isInstanceOf(OutputLookup.Unavailable.class);
            failed.add(id);
        }
        assertThat(w.manifests.find(ready, T0)).isEqualTo(readyBefore);
        assertThat(Files.readAllBytes(w.file(ready, PayloadKind.OUT))).isEqualTo(readyBytes);

        OutputId later = w.reserve(binding, 1024, T0);
        w.manifests.markReady(later, w.payloads.finish(later, utf8("{}"), utf8("after failures")), 16);
        assertThat(w.manifests.find(later, T0)).isInstanceOf(OutputLookup.Ready.class);
        assertThat(w.manifests.budget().count()).as("twelve failures and two outputs").isEqualTo(14);

        OutputWorld restarted = factory.create(folder, LIMITS);
        restarted.startup.reconcile(T0);
        for (OutputId id : failed) {
            assertThat(restarted.charge(id)).isZero();
        }
        assertThat(restarted.manifests.find(ready, T0)).isEqualTo(readyBefore);
        assertThat(Files.readAllBytes(restarted.file(ready, PayloadKind.OUT))).isEqualTo(readyBytes);
        assertThat(restarted.manifests.budget().chargedBytes()).isEqualTo(17L + 16L);
    }

    @ParameterizedTest(name = "RC-A-489: partial bytes stay charged and unavailable after a restart (the give-up was recorded: {0}); the failure details of the result belong to the capture use case")
    @ValueSource(booleans = {true, false})
    void partialBytesStayChargedAcrossRestart(boolean giveUpRecorded, @TempDir Path folder) throws IOException {
        OutputWorld w = factory.create(folder, LIMITS);
        OutputId id = w.reserve(fixture.unbound(), 1024, T0);
        assertThat(w.payloads.append(id, new StreamFrame(StreamKind.STDOUT, utf8("ab")))).as("5 header bytes and 2 data bytes").isEqualTo(7L);
        byte[] bytes = Files.readAllBytes(w.file(id, PayloadKind.STREAM));
        if (giveUpRecorded) {
            w.manifests.markUnavailable(id, T0.plusMillis(50));
            assertThat(w.charge(id)).isEqualTo(7L);
        } else {
            assertThat(w.row(id).state()).as("the persistence of the give-up failed: the row is still pending").isEqualTo(OutputState.PENDING);
            assertThat(w.charge(id)).isEqualTo(1024L);
        }

        OutputWorld restarted = factory.create(folder, LIMITS);
        restarted.startup.reconcile(T0);

        assertThat(restarted.row(id).state()).isEqualTo(OutputState.UNAVAILABLE);
        assertThat(restarted.charge(id)).isEqualTo(7L);
        assertThat(restarted.row(id).expiresAt()).as("a restart does not renew the retention").isEqualTo(T0.plusMillis(50));
        assertThat(Files.readAllBytes(restarted.file(id, PayloadKind.STREAM))).isEqualTo(bytes);
        assertThat(restarted.manifests.find(id, T0)).isInstanceOf(OutputLookup.Unavailable.class);
    }

    @Test
    @DisplayName("RC-A-490: when publishing as ready fails, giving the output up keeps the complete payload and charges its actual size, also after a restart")
    void publicationFailureKeepsThePayloadAndItsCharge(@TempDir Path folder) throws IOException {
        OutputWorld w = factory.create(folder, LIMITS);
        OutputId id = w.reserve(fixture.unbound(), 1024, T0);
        w.payloads.finish(id, utf8("{\"failed\":true}"), utf8("complete retained payload"));
        byte[] bytes = Files.readAllBytes(w.file(id, PayloadKind.OUT));

        w.manifests.markUnavailable(id, T0.plusMillis(50));

        assertThat(w.charge(id)).isEqualTo(bytes.length);
        OutputWorld restarted = factory.create(folder, LIMITS);
        restarted.startup.reconcile(T0);
        assertThat(Files.readAllBytes(restarted.file(id, PayloadKind.OUT))).isEqualTo(bytes);
        assertThat(restarted.charge(id)).isEqualTo(bytes.length);
    }

    @Test
    @DisplayName("RC-A-491: a restart measures old unavailable and interrupted reservations again from both files, keeps the expiry and the manifest, "
        + "follows a cut file, and the reaper removes both files and the row")
    void restartMeasuresTheChargeAgain(@TempDir Path folder) throws IOException {
        OutputWorld w = factory.create(folder, LIMITS);
        OutputBinding binding = fixture.unbound();
        OutputId old = w.reserve(binding, 1024, T0);
        OutputId interrupted = w.reserve(binding, 1024, T0);
        Instant expiry = T0.plusMillis(50);
        w.manifests.markUnavailable(old, expiry);
        w.plant(w.file(old, PayloadKind.STREAM), utf8("partial evidence"));
        w.plant(w.file(old, PayloadKind.OUT), utf8("published evidence"));
        w.plant(w.file(interrupted, PayloadKind.STREAM), utf8("interrupted evidence"));
        w.forceCharge(old, 1024);
        CommandOutputRow original = w.row(old);

        OutputWorld restarted = factory.create(folder, LIMITS);
        restarted.startup.reconcile(T0.plusMillis(20));

        CommandOutputRow measured = restarted.row(old);
        assertThat(measured.withVersion(0).withChargeBytes(0)).as("only the charge changes").isEqualTo(original.withVersion(0).withChargeBytes(0));
        assertThat(measured.chargeBytes()).isEqualTo(16L + 18L);
        assertThat(restarted.row(interrupted).state()).isEqualTo(OutputState.UNAVAILABLE);
        assertThat(restarted.row(interrupted).expiresAt()).as("a restart does not renew the retention").isEqualTo(expiry);
        assertThat(restarted.charge(interrupted)).isEqualTo(20L);

        restarted.plant(restarted.file(old, PayloadKind.STREAM), utf8("cut"));
        OutputWorld again = factory.create(folder, LIMITS);
        again.startup.reconcile(T0.plusMillis(20));
        assertThat(again.charge(old)).isEqualTo(3L + 18L).isLessThan(measured.chargeBytes());
        assertThat(Files.readString(again.file(old, PayloadKind.STREAM), StandardCharsets.UTF_8)).isEqualTo("cut");

        again.startup.reconcile(T0.plusMillis(51));
        assertThat(again.manifests.budget().count()).isZero();
        assertThat(Files.exists(again.file(old, PayloadKind.STREAM))).isFalse();
        assertThat(Files.exists(again.file(old, PayloadKind.OUT))).isFalse();
        assertThat(Files.exists(again.file(interrupted, PayloadKind.STREAM))).isFalse();
    }

    @Test
    @DisplayName("RC-A-492 (the accounting half): an old overcharge refuses a normal reservation until the charge is measured again, then the old output costs nothing "
        + "and the new one its reservation; the maintenance guard that keeps rows and bytes while a window is open belongs to the maintenance use case")
    void measuringAgainFreesTheBudget(@TempDir Path folder) {
        OutputWorld w = factory.create(folder, ONE);
        OutputBinding binding = fixture.unbound();
        OutputId old = w.reserve(binding, 1024, T0);
        w.manifests.markUnavailable(old, T0.plusMillis(50));
        w.forceCharge(old, 1024);

        assertThat(w.manifests.reserve(binding, 1024, T0)).isInstanceOf(OutputReservation.BudgetExceeded.class);
        w.startup.recover(T0);
        OutputId next = w.reserve(binding, 1024, T0);

        assertThat(w.charge(old)).isZero();
        assertThat(w.charge(next)).isEqualTo(1024L);
    }

    @Test
    @DisplayName("RC-A-493: an output that never wrote a byte holds nothing (3.0 creates no file at reservation, so there is no 'missing' file to doubt)")
    void aReservationWithoutFilesHoldsNothing(@TempDir Path folder) {
        OutputWorld w = factory.create(folder, LIMITS);
        OutputId id = w.reserve(fixture.unbound(), 1024, T0);

        w.manifests.markUnavailable(id, T0.plusMillis(50));

        assertChargeAcrossRestart(folder, w, id, 0L);
    }

    @Test
    @DisplayName("RC-A-493: a payload with a second hard link is not measured as safe, so the reservation stays charged (where the file store reports link counts)")
    void aSecondHardLinkKeepsTheReservation(@TempDir Path folder) throws IOException {
        OutputWorld w = factory.create(folder, LIMITS);
        OutputId id = w.reserve(fixture.unbound(), 1024, T0);
        w.append(id, StreamKind.STDOUT, "x");
        Files.createLink(folder.resolve("unsafe-extra-link"), w.file(id, PayloadKind.STREAM));
        boolean linkCountVisible = Files.getFileStore(folder).supportsFileAttributeView("unix");

        w.manifests.markUnavailable(id, T0.plusMillis(50));

        assertChargeAcrossRestart(folder, w, id, linkCountVisible ? 1024L : 6L);
    }

    @Test
    @DisplayName("RC-A-493: oversize evidence is charged in full, more than the reservation")
    void oversizeBytesAreChargedInFull(@TempDir Path folder) throws IOException {
        OutputWorld w = factory.create(folder, LIMITS);
        OutputId id = w.reserve(fixture.unbound(), 1024, T0);
        byte[] bytes = new byte[1024 + 7];
        Arrays.fill(bytes, (byte) 'x');
        w.plant(w.file(id, PayloadKind.STREAM), bytes);

        w.manifests.markUnavailable(id, T0.plusMillis(50));

        assertChargeAcrossRestart(folder, w, id, 1031L);
    }

    @Test
    @DisplayName("RC-A-494: a capture larger than the reservation writes nothing and is refused with OUTPUT_CAPACITY; giving the output up releases its charge, "
        + "and while one reservation is active a second is refused; the result and failure details belong to the capture use case")
    void anOversizeCaptureReleasesItsReservation(@TempDir Path folder) {
        OutputWorld w = factory.create(folder, ONE);
        OutputId id = w.reserve(fixture.unbound(), 1024, T0);

        assertThatThrownBy(() -> w.payloads.finish(id, utf8("{}"), utf8("x".repeat(1024)))).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(ExecutionErrorCode.OUTPUT_CAPACITY));
        assertThat(Files.exists(w.file(id, PayloadKind.OUT))).isFalse();
        assertThat(Files.exists(w.file(id, PayloadKind.PART))).isFalse();
        w.manifests.markUnavailable(id, T0.plusMillis(50));
        assertThat(w.charge(id)).isZero();

        w.reserve(fixture.unbound(), 1024, T0);
        OutputReservation second = w.manifests.reserve(fixture.unbound(), 1024, T0);
        assertThat(second).isEqualTo(new OutputReservation.BudgetExceeded(1024L, 1024L, 1024L));
    }

    @Test
    @DisplayName("RC-A-497: a finished output stores both renderings after the spool, charges their size, removes the spool and accepts no more frames, also after a restart; "
        + "the execution metadata and the stream read after finish are not 3.0 behaviour (the spool is removed)")
    void finishingClosesTheOutput(@TempDir Path folder) throws IOException {
        OutputWorld w = factory.create(folder, LIMITS);
        OutputId id = w.reserve(fixture.unbound(), 1024, T0);
        w.append(id, StreamKind.STDOUT, "some");
        w.append(id, StreamKind.STDERR, "warn");
        byte[] spool = Files.readAllBytes(w.file(id, PayloadKind.STREAM));
        StreamInfo.CompleteStream complete = new StreamInfo.CompleteStream(8, spool.length, new Sha256Digester().digest(spool), 4, 4, StreamInfo.Truncation.COMPLETE);
        w.manifests.recordStream(id, complete);
        byte[] json = utf8("{\"failed\":true,\"execution\":{\"reason\":\"deadline\",\"timeoutMs\":120000}}");
        byte[] text = utf8("some\nwarn");

        OutputFormats formats = w.payloads.finish(id, json, text);
        OutputManifest ready = w.manifests.markReady(id, formats, (long) json.length + text.length);

        assertThat(Files.exists(w.file(id, PayloadKind.STREAM))).isFalse();
        assertThat(ready.chargeBytes()).isEqualTo(Files.size(w.file(id, PayloadKind.OUT)));
        assertThat(ready.stream()).isEqualTo(complete);
        assertThat(readAll(w.payloads.openFormat(id, OutputFormat.TEXT, formats.spans().get(OutputFormat.TEXT)))).isEqualTo(text);
        assertThat(readAll(w.payloads.openFormat(id, OutputFormat.JSON, formats.spans().get(OutputFormat.JSON)))).isEqualTo(json);
        assertThatThrownBy(() -> w.append(id, StreamKind.STDOUT, "late")).as("closed").isInstanceOf(RequestRefusedException.class);
        assertThatThrownBy(() -> w.manifests.recordStream(id, new StreamInfo.OpenStream(1))).isInstanceOf(RequestRefusedException.class);

        OutputWorld restarted = factory.create(folder, LIMITS);
        restarted.startup.reconcile(T0);
        assertThat(restarted.manifests.find(id, T0)).isEqualTo(new OutputLookup.Ready(ready));
        assertThat(readAll(restarted.payloads.openFormat(id, OutputFormat.TEXT, formats.spans().get(OutputFormat.TEXT)))).isEqualTo(text);
    }

    @Test
    @DisplayName("RC-A-503: bytes that are on disk but not yet in the manifest stay on disk and are charged after a restart; the manifest keeps the last recorded size; "
        + "the cursor reads of the stream belong to the stream-read use case")
    void uncommittedBytesStayAndAreCharged(@TempDir Path folder) throws IOException {
        OutputWorld w = factory.create(folder, LIMITS);
        OutputId id = w.reserve(fixture.unbound(), 1024, T0);
        long committed = w.append(id, StreamKind.STDOUT, "committed");
        w.manifests.recordStream(id, new StreamInfo.OpenStream(committed));
        long total = w.append(id, StreamKind.STDERR, "uncommitted");

        assertThat(committed).isEqualTo(14L);
        assertThat(w.row(id).streamBytes()).isEqualTo(14L);
        assertThat(Files.size(w.file(id, PayloadKind.STREAM))).isEqualTo(total).isGreaterThan(w.row(id).streamBytes());

        OutputWorld restarted = factory.create(folder, LIMITS);
        restarted.startup.reconcile(T0);

        assertThat(restarted.row(id).state()).isEqualTo(OutputState.UNAVAILABLE);
        assertThat(restarted.row(id).streamBytes()).isEqualTo(14L);
        assertThat(restarted.charge(id)).isEqualTo(Files.size(restarted.file(id, PayloadKind.STREAM))).isEqualTo(30L);
    }

    @Test
    @DisplayName("RC-A-504: giving an output up keeps the bytes it received and charges them; the eof and state reads of the stream and the sanitising of the execution metadata "
        + "belong to use cases")
    void givingUpKeepsTheBytes(@TempDir Path folder) throws IOException {
        OutputWorld w = factory.create(folder, LIMITS);
        OutputId id = w.reserve(fixture.unbound(), 1024, T0);
        w.append(id, StreamKind.STDOUT, "before transport loss");
        byte[] before = Files.readAllBytes(w.file(id, PayloadKind.STREAM));

        w.manifests.markUnavailable(id, T0.plusMillis(50));

        assertThat(Files.readAllBytes(w.file(id, PayloadKind.STREAM))).isEqualTo(before);
        assertThat(w.charge(id)).isEqualTo(26L);
        assertThat(w.row(id).state()).isEqualTo(OutputState.UNAVAILABLE);
    }

    @Test
    @DisplayName("RC-A-506 (the retention half): an expired output keeps its row and its bytes until the reaper runs, is expired for readers meanwhile, and the reaper then removes "
        + "the bytes and the row; the maintenance guard that withholds the reaper belongs to the maintenance use case")
    void expiredBytesWaitForTheReaper(@TempDir Path folder) throws IOException {
        OutputWorld w = factory.create(folder, LIMITS);
        OutputId id = w.reserve(fixture.unbound(), 1024, T0);
        w.append(id, StreamKind.STDERR, "retain under maintenance");
        w.manifests.markUnavailable(id, T0.plusMillis(50));
        CommandOutputRow row = w.row(id);
        byte[] bytes = Files.readAllBytes(w.file(id, PayloadKind.STREAM));
        Instant now = T0.plusMillis(51);

        assertThat(w.manifests.find(id, now)).as("retention never extends read authority").isInstanceOf(OutputLookup.Expired.class);
        w.startup.recover(now);

        assertThat(w.row(id)).isEqualTo(row);
        assertThat(Files.readAllBytes(w.file(id, PayloadKind.STREAM))).isEqualTo(bytes);
        w.startup.reap(now);
        assertThat(Files.exists(w.file(id, PayloadKind.STREAM))).isFalse();
        assertThat(w.manifests.find(id, now)).isInstanceOf(OutputLookup.Missing.class);
        assertThat(w.manifests.budget().count()).isZero();
    }

    @Test
    @DisplayName("RC-A-508: capacity, expiry and an interrupted capture do not depend on the execution that made the output")
    void capacityAndExpiryAreIndependentOfTheExecution(@TempDir Path folder) {
        OutputWorld w = factory.create(folder, ONE);
        OutputId interrupted = w.reserve(fixture.unbound(), 1024, T0);
        assertThat(w.manifests.reserve(fixture.unbound(), 1024, T0)).isInstanceOf(OutputReservation.BudgetExceeded.class);

        OutputWorld restarted = factory.create(folder, ONE);
        restarted.startup.reconcile(T0);
        assertThat(restarted.manifests.find(interrupted, T0)).isInstanceOf(OutputLookup.Unavailable.class);
        restarted.startup.reconcile(T0.plusMillis(51));
        assertThat(restarted.manifests.find(interrupted, T0.plusMillis(51))).isInstanceOf(OutputLookup.Missing.class);

        Instant later = T0.plusMillis(60);
        OutputId oversize = restarted.reserve(fixture.unbound(), 1024, later);
        assertThatThrownBy(() -> restarted.payloads.finish(oversize, utf8("{}"), utf8("x".repeat(2048)))).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(ExecutionErrorCode.OUTPUT_CAPACITY));
        restarted.manifests.markUnavailable(oversize, later.plusMillis(50));
        assertThat(restarted.charge(oversize)).isZero();
        assertThat(restarted.manifests.find(oversize, later)).isInstanceOf(OutputLookup.Unavailable.class);
    }

    @Test
    @DisplayName("RC-A-509 (the retention half): an expired output keeps its row and bytes at recovery and still charges the budget, so a new reservation is refused; "
        + "after the reaper it is removed and a reservation succeeds; the maintenance guard belongs to the maintenance use case")
    void expiredOutputsStillChargeUntilTheyAreReaped(@TempDir Path folder) throws IOException {
        OutputWorld w = factory.create(folder, ONE);
        OutputBinding binding = fixture.unbound();
        OutputId id = w.reserve(binding, 1024, T0);
        w.manifests.markReady(id, w.payloads.finish(id, utf8("{}"), utf8("preserved across maintenance")), 30);
        List<CommandOutputRow> rowsBefore = allRows(w);
        byte[] bytes = Files.readAllBytes(w.file(id, PayloadKind.OUT));
        Instant now = T0.plusMillis(51);

        w.startup.recover(now);

        assertThat(allRows(w)).isEqualTo(rowsBefore);
        assertThat(Files.readAllBytes(w.file(id, PayloadKind.OUT))).isEqualTo(bytes);
        assertThat(w.manifests.reserve(binding, 1024, now)).as("the expired baseline is not cleared by a reservation").isInstanceOf(OutputReservation.BudgetExceeded.class);
        assertThat(w.manifests.find(id, now)).as("retention never extends read authority").isInstanceOf(OutputLookup.Expired.class);
        OutputWorld restarted = factory.create(folder, ONE);
        restarted.startup.recover(now);
        assertThat(allRows(restarted)).isEqualTo(rowsBefore);

        restarted.startup.reap(now);

        assertThat(allRows(restarted)).isEmpty();
        assertThat(Files.exists(restarted.file(id, PayloadKind.OUT))).isFalse();
        assertThat(restarted.manifests.reserve(binding, 1024, now)).isInstanceOf(OutputReservation.Reserved.class);
    }

    @Test
    @DisplayName("RC-A-510: payload bytes that were written before any manifest row existed are quarantined at start-up and nothing is blocked or replayed; "
        + "the bytes of a known output stay where they are")
    void orphanBytesAreQuarantined(@TempDir Path folder) throws IOException {
        OutputWorld w = factory.create(folder, LIMITS);
        OutputId known = w.reserve(fixture.unbound(), 1024, T0);
        w.append(known, StreamKind.STDOUT, "known");
        OutputId orphan = new OutputId("f".repeat(48));
        w.plant(w.file(orphan, PayloadKind.PART), new byte[0]);

        OutputWorld restarted = factory.create(folder, LIMITS);
        restarted.startup.reconcile(T0);

        assertThat(restarted.manifests.find(orphan, T0)).isInstanceOf(OutputLookup.Missing.class);
        assertThat(restarted.payloads.stored()).containsExactly(known);
        assertThat(Files.exists(folder.resolve("quarantine").resolve(orphan.value() + ".part"))).isTrue();
        assertThat(Files.exists(restarted.file(known, PayloadKind.STREAM))).isTrue();
        assertThat(restarted.row(known).state()).isEqualTo(OutputState.UNAVAILABLE);
        assertThat(restarted.manifests.budget().count()).as("the orphan gets no row").isEqualTo(1);
    }
}
