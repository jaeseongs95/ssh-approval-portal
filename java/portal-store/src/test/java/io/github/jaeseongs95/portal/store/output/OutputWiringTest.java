package io.github.jaeseongs95.portal.store.output;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

import javax.sql.DataSource;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.Import;

import io.github.jaeseongs95.portal.app.output.OutputLookup;
import io.github.jaeseongs95.portal.app.output.OutputManifestStore;
import io.github.jaeseongs95.portal.app.output.OutputPayloadStore;
import io.github.jaeseongs95.portal.app.output.OutputReservation;
import io.github.jaeseongs95.portal.store.StoreTest;

/** The adapters as the product wires them: scanned stereotypes with constructor injection and the limits bean of {@link OutputConfiguration}. */
@StoreTest
@Import({JdbcOutputManifestStore.class, FileOutputPayloadStore.class, OutputFiles.class, OutputStartupCheck.class, OutputMapper.class, OutputConfiguration.class,
    OutputWiringBeans.class})
class OutputWiringTest {

    private static final Instant T0 = Clock.fixed(Instant.parse("2026-11-12T00:00:00Z"), ZoneOffset.UTC).instant();

    private final OutputManifestStore manifests;
    private final OutputPayloadStore payloads;
    private final OutputStartupCheck startup;
    private final OutputFixture fixture;

    OutputWiringTest(OutputManifestStore manifests, OutputPayloadStore payloads, OutputStartupCheck startup, DataSource dataSource) {
        this.manifests = manifests;
        this.payloads = payloads;
        this.startup = startup;
        this.fixture = new OutputFixture(dataSource);
    }

    @Test
    @DisplayName("S2-OUT-06: the output adapters wire into one Spring context and work through the ports: reserve, find, start-up check")
    void theAdaptersWorkThroughThePorts() {
        OutputReservation reservation = manifests.reserve(fixture.unbound(), 100, T0);

        assertThat(reservation).isInstanceOf(OutputReservation.Reserved.class);
        OutputReservation.Reserved reserved = (OutputReservation.Reserved) reservation;
        assertThat(manifests.find(reserved.id(), T0)).isInstanceOf(OutputLookup.Pending.class);
        assertThat(payloads.usable().usableBytes()).isPositive();

        startup.reconcile(T0);

        assertThat(manifests.find(reserved.id(), T0)).isInstanceOf(OutputLookup.Unavailable.class);
        assertThat(manifests.budget().count()).isEqualTo(1);
    }
}
