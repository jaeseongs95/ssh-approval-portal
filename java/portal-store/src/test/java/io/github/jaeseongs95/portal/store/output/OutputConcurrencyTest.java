package io.github.jaeseongs95.portal.store.output;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import javax.sql.DataSource;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.Import;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import io.github.jaeseongs95.portal.app.output.OutputFormats;
import io.github.jaeseongs95.portal.app.output.OutputId;
import io.github.jaeseongs95.portal.app.output.OutputPayloadStore;
import io.github.jaeseongs95.portal.app.output.OutputReservation;
import io.github.jaeseongs95.portal.app.output.OutputState;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.store.StoreTest;

/**
 * Two writers of one output at the same time, through the Spring-wired (transactional) store and each in its own committed transactions. The test is not wrapped in
 * a transaction, so it removes its rows itself. The version column decides: one writer wins and the other is refused, whichever of the two reads the row first.
 */
@StoreTest
@Import({JdbcOutputManifestStore.class, FileOutputPayloadStore.class, OutputFiles.class, OutputMapper.class, OutputConfiguration.class, OutputWiringBeans.class})
@Transactional(propagation = Propagation.NOT_SUPPORTED)
class OutputConcurrencyTest {

    private static final Instant T0 = Clock.fixed(Instant.parse("2026-11-12T00:00:00Z"), ZoneOffset.UTC).instant();

    private final JdbcOutputManifestStore manifests;
    private final OutputPayloadStore payloads;
    private final CommandOutputRowRepository rows;
    private final CommandOutputFormatRowRepository formats;
    private final OutputFixture fixture;

    OutputConcurrencyTest(JdbcOutputManifestStore manifests, OutputPayloadStore payloads, CommandOutputRowRepository rows, CommandOutputFormatRowRepository formats,
                          DataSource dataSource) {
        this.manifests = manifests;
        this.payloads = payloads;
        this.rows = rows;
        this.formats = formats;
        this.fixture = new OutputFixture(dataSource);
    }

    @Test
    @DisplayName("S2-OUT-05: two writers that make the same pending output ready at once: exactly one wins, the other is refused, and the row is ready at version 2")
    void exactlyOneWriterWins() throws Exception {
        try {
            OutputReservation reservation = manifests.reserve(fixture.unbound(), 1000, T0);
            OutputId id = ((OutputReservation.Reserved) reservation).id();
            OutputFormats finished = payloads.finish(id, "{}".getBytes(StandardCharsets.UTF_8), "text".getBytes(StandardCharsets.UTF_8));
            CyclicBarrier start = new CyclicBarrier(2);
            Callable<Boolean> attempt = () -> {
                start.await(10, TimeUnit.SECONDS);
                try {
                    manifests.markReady(id, finished, 6);
                    return true;
                } catch (RequestRefusedException refused) {
                    // The loser either lost the compare-and-set (OUTPUT_VERSION_CONFLICT, S3-UC-07) or read the row after the winner committed (the row is READY).
                    assertThat(refused.code()).isIn(OperationErrorCode.OUTPUT_VERSION_CONFLICT, ExecutionErrorCode.OUTPUT_CAPTURE_FAILED);
                    return false;
                }
            };

            ExecutorService writers = Executors.newFixedThreadPool(2);
            List<Boolean> outcomes;
            try {
                Future<Boolean> first = writers.submit(attempt);
                Future<Boolean> second = writers.submit(attempt);
                outcomes = List.of(first.get(30, TimeUnit.SECONDS), second.get(30, TimeUnit.SECONDS));
            } finally {
                writers.shutdownNow();
            }

            assertThat(outcomes).containsExactlyInAnyOrder(true, false);
            CommandOutputRow row = rows.findById(id.value()).orElseThrow();
            assertThat(row.state()).isEqualTo(OutputState.READY);
            assertThat(row.version()).isEqualTo(2L);
            assertThat(formats.findByOutputId(id.value())).hasSize(2);
        } finally {
            fixture.clean();
        }
    }
}
