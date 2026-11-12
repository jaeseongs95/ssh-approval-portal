package io.github.jaeseongs95.portal.store.output;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;

import javax.sql.DataSource;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.annotation.Import;

import io.github.jaeseongs95.portal.app.output.OutputBinding;
import io.github.jaeseongs95.portal.app.output.OutputFormats;
import io.github.jaeseongs95.portal.app.output.OutputId;
import io.github.jaeseongs95.portal.app.output.OutputLookup;
import io.github.jaeseongs95.portal.app.output.OutputManifest;
import io.github.jaeseongs95.portal.app.output.OutputReservation;
import io.github.jaeseongs95.portal.app.output.OutputState;
import io.github.jaeseongs95.portal.app.output.StreamInfo;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.store.StoreTest;

/** The manifest part of the output store on the test database (Flyway applies the real scripts). Time comes from a fixed clock, never from the machine. */
@StoreTest
@Import({OutputMapper.class, OutputWorldFactory.class})
class JdbcOutputManifestStoreTest {

    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-12T00:00:00Z"), ZoneOffset.UTC);
    private static final Instant T0 = CLOCK.instant();

    private final OutputWorldFactory factory;
    private final OutputFixture fixture;

    JdbcOutputManifestStoreTest(OutputWorldFactory factory, DataSource dataSource) {
        this.factory = factory;
        this.fixture = new OutputFixture(dataSource);
    }

    private OutputLimits limits(long maxOutput, long budget, int maxCount, long diskMargin) {
        return new OutputLimits(Duration.ofHours(1), maxOutput, budget, maxCount, diskMargin);
    }

    private byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private <T extends OutputReservation> T refusal(OutputReservation reservation, Class<T> type) {
        assertThat(reservation).isInstanceOf(type);
        return type.cast(reservation);
    }

    @Test
    @DisplayName("S2-OUT-01: a reservation is refused as too large and then by the count, in that order, and a refusal creates no row")
    void tooLargeAndCountAreRefused(@TempDir Path folder) {
        OutputWorld w = factory.create(folder, limits(1024, 2048, 2, 0L));
        OutputBinding binding = fixture.unbound();

        assertThat(refusal(w.manifests.reserve(binding, 1025, T0), OutputReservation.TooLarge.class).limitBytes()).isEqualTo(1024L);
        assertThat(w.manifests.budget().count()).isZero();

        w.reserve(binding, 1024, T0);
        w.reserve(binding, 1024, T0);
        assertThat(refusal(w.manifests.reserve(binding, 1, T0), OutputReservation.CountExceeded.class).maxCount()).isEqualTo(2);
        assertThat(w.manifests.budget().count()).isEqualTo(2);
    }

    @Test
    @DisplayName("S2-OUT-01: a reservation is refused when the charges plus the request pass the budget, and the budget reports the charges")
    void budgetIsRefused(@TempDir Path folder) {
        OutputWorld w = factory.create(folder, limits(1024, 2048, 10, 0L));
        OutputBinding binding = fixture.unbound();
        w.reserve(binding, 1024, T0);
        w.reserve(binding, 1000, T0);

        OutputReservation.BudgetExceeded refused = refusal(w.manifests.reserve(binding, 25, T0), OutputReservation.BudgetExceeded.class);

        assertThat(refused.requestedBytes()).isEqualTo(25L);
        assertThat(refused.chargedBytes()).isEqualTo(2024L);
        assertThat(refused.budgetBytes()).isEqualTo(2048L);
        assertThat(w.manifests.budget().chargedBytes()).isEqualTo(2024L);
        assertThat(w.manifests.budget().budgetBytes()).isEqualTo(2048L);
        assertThat(w.manifests.budget().maxCount()).isEqualTo(10);
        assertThat(w.manifests.budget().count()).isEqualTo(2);
        w.reserve(binding, 24, T0);
    }

    @Test
    @DisplayName("S2-OUT-01: a reservation is refused when the disk of the payload folder lacks the per-output limit plus the margin")
    void diskSpaceIsRefused(@TempDir Path folder) {
        OutputWorld w = factory.create(folder, limits(1024, 2048, 10, Long.MAX_VALUE));
        OutputBinding binding = fixture.unbound();

        OutputReservation.DiskSpaceInsufficient refused = refusal(w.manifests.reserve(binding, 10, T0), OutputReservation.DiskSpaceInsufficient.class);

        assertThat(refused.requiredBytes()).isEqualTo(Long.MAX_VALUE);
        assertThat(refused.usableBytes()).isPositive().isLessThan(Long.MAX_VALUE);
        assertThat(w.manifests.budget().count()).isZero();
    }

    @Test
    @DisplayName("S2-OUT-02: find tells missing, pending, ready, unavailable and expired apart; the expiry derives from expires_at (now equal to it is expired)")
    void findAnswersTheFiveStates(@TempDir Path folder) {
        OutputWorld w = factory.create(folder, OutputLimits.defaults());
        OutputBinding bound = fixture.bound();
        assertThat(w.manifests.find(new OutputId("e".repeat(48)), T0)).isInstanceOf(OutputLookup.Missing.class);

        OutputId id = w.reserve(bound, 1000, T0);
        Instant expiresAt = T0.plus(Duration.ofHours(1));
        assertThat(w.manifests.find(id, T0)).isInstanceOf(OutputLookup.Pending.class);

        Digest digest = new Digest("d".repeat(64));
        OutputManifest open = w.manifests.recordStream(id, new StreamInfo.OpenStream(7));
        assertThat(open.state()).isEqualTo(OutputState.PENDING);
        assertThat(open.stream()).isEqualTo(new StreamInfo.OpenStream(7));
        assertThat(open.chargeBytes()).isEqualTo(1000L);
        assertThat(open.binding()).isEqualTo(bound);
        assertThat(open.expiresAt()).isEqualTo(expiresAt);
        StreamInfo.CompleteStream complete = new StreamInfo.CompleteStream(8, 18, digest, 4, 4, StreamInfo.Truncation.COMPLETE);
        assertThat(w.manifests.recordStream(id, complete).stream()).isEqualTo(complete);

        OutputFormats formats = w.payloads.finish(id, utf8("{}"), utf8("some\nwarn"));
        OutputManifest ready = w.manifests.markReady(id, formats, 11);
        assertThat(ready.state()).isEqualTo(OutputState.READY);
        assertThat(ready.chargeBytes()).as("the charge becomes the real size").isEqualTo(11L);
        assertThat(ready.sizeBytes()).isEqualTo(11L);
        assertThat(ready.version()).isEqualTo(4L);
        assertThat(w.manifests.find(id, T0)).isEqualTo(new OutputLookup.Ready(ready));
        assertThat(w.manifests.find(id, expiresAt.minusNanos(1_000))).isInstanceOf(OutputLookup.Ready.class);
        assertThat(w.manifests.find(id, expiresAt)).isInstanceOf(OutputLookup.Expired.class);

        OutputId given = w.reserve(fixture.unbound(), 1000, T0);
        w.manifests.markUnavailable(given, expiresAt);
        assertThat(w.manifests.find(given, T0)).isInstanceOf(OutputLookup.Unavailable.class);
        assertThat(w.manifests.find(given, expiresAt)).isInstanceOf(OutputLookup.Expired.class);
        assertThat(w.row(given).targetId()).isNull();
    }

    @Test
    @DisplayName("S2-OUT-03: a change that does not fit the state is refused: ready twice, a stream after ready, a completed stream reopened, a ready output given up, an unknown output")
    void changesThatDoNotFitTheStateAreRefused(@TempDir Path folder) {
        OutputWorld w = factory.create(folder, OutputLimits.defaults());
        OutputBinding binding = fixture.unbound();
        OutputId id = w.reserve(binding, 100, T0);
        OutputFormats formats = w.payloads.finish(id, utf8("{}"), utf8("t"));
        Digest digest = new Digest("d".repeat(64));

        assertThatThrownBy(() -> w.manifests.recordStream(id, new StreamInfo.NoStream())).isInstanceOf(IllegalArgumentException.class);
        w.manifests.recordStream(id, new StreamInfo.CompleteStream(1, 6, digest, 1, 0, StreamInfo.Truncation.COMPLETE));
        assertThatThrownBy(() -> w.manifests.recordStream(id, new StreamInfo.OpenStream(9))).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(ExecutionErrorCode.OUTPUT_CAPTURE_FAILED));

        w.manifests.markReady(id, formats, 3);
        assertThatThrownBy(() -> w.manifests.markReady(id, formats, 3)).isInstanceOf(RequestRefusedException.class);
        assertThatThrownBy(() -> w.manifests.recordStream(id, new StreamInfo.OpenStream(1))).isInstanceOf(RequestRefusedException.class);
        assertThatThrownBy(() -> w.manifests.markUnavailable(id, T0)).isInstanceOf(RequestRefusedException.class);
        assertThatThrownBy(() -> w.manifests.markReady(new OutputId("e".repeat(48)), formats, 3)).isInstanceOf(RequestRefusedException.class);
        assertThat(w.row(id).state()).isEqualTo(OutputState.READY);
        assertThat(w.row(id).version()).isEqualTo(3L);
    }

    @Test
    @DisplayName("RC-A-502: the capacity of an output is checked when it is reserved, before dispatch; the refused reservation leaves no row and no stream, "
        + "and the output that was accepted still becomes ready")
    void capacityIsCheckedBeforeDispatch(@TempDir Path folder) {
        OutputWorld w = factory.create(folder, limits(1024, 1024, 10, 0L));
        OutputBinding binding = fixture.unbound();
        OutputId accepted = w.reserve(binding, 1024, T0);

        OutputReservation.BudgetExceeded refused = refusal(w.manifests.reserve(binding, 1024, T0), OutputReservation.BudgetExceeded.class);

        assertThat(refused.chargedBytes()).isEqualTo(1024L);
        assertThat(w.manifests.budget().count()).isEqualTo(1);
        assertThat(w.row(accepted).streamState()).isEqualTo(StreamState.NONE);
        OutputFormats formats = w.payloads.finish(accepted, utf8("{}"), utf8("legacy"));
        assertThat(w.manifests.markReady(accepted, formats, 8).state()).isEqualTo(OutputState.READY);
        assertThat(w.manifests.budget().chargedBytes()).isEqualTo(8L);
    }

    @Test
    @DisplayName("S2-OUT-04: expired lists the outputs whose expiry is not after now; delete removes the rows of the output, its renderings and its pages, and is repeatable")
    void expiredAndDelete(@TempDir Path folder) {
        OutputWorld w = factory.create(folder, OutputLimits.defaults());
        OutputBinding binding = fixture.unbound();
        OutputId first = w.reserve(binding, 100, T0);
        OutputId second = w.reserve(binding, 100, T0.plus(Duration.ofMinutes(10)));
        OutputFormats formats = w.payloads.finish(first, utf8("{}"), utf8("text"));
        w.manifests.markReady(first, formats, 6);

        assertThat(w.manifests.expired(T0.plus(Duration.ofMinutes(59)))).isEmpty();
        assertThat(w.manifests.expired(T0.plus(Duration.ofHours(1))).stream().map(OutputManifest::id).toList()).containsExactly(first);
        assertThat(w.manifests.expired(T0.plus(Duration.ofMinutes(70))).stream().map(OutputManifest::id).toList()).containsExactlyInAnyOrder(first, second);
        List<OutputManifest> expired = w.manifests.expired(T0.plus(Duration.ofHours(1)));
        assertThat(expired.get(0).formats().spans()).hasSize(2);
        assertThat(w.formats.findByOutputId(first.value())).hasSize(2);

        w.manifests.delete(first);

        assertThat(w.manifests.find(first, T0)).isInstanceOf(OutputLookup.Missing.class);
        assertThat(w.formats.findByOutputId(first.value())).isEmpty();
        assertThat(w.pages.findByOutputIdOrderByFormatAscPageNoAsc(first.value())).isEmpty();
        w.manifests.delete(first);
        assertThat(w.manifests.budget().count()).isEqualTo(1);
    }
}
