package io.github.jaeseongs95.portal.domain.schedule;

import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.pending;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.queued;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import java.time.Duration;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class AdmissionLimitsTest {

    @Test
    @DisplayName("RC-A-745 the request entrance has 8 active, 32 waiting, 5 seconds and 64 detached by default, and refuses invalid numbers")
    void defaultsAndValidation() {
        AdmissionLimits defaults = AdmissionLimits.defaults();
        assertThat(defaults).isEqualTo(new AdmissionLimits(new Capacity(8), 32, Duration.ofMillis(5000), 64));
        assertThat(new AdmissionLimits(new Capacity(1), 0, Duration.ofMillis(1), 0).maxQueued()).isZero();
        assertThat(new AdmissionLimits(new Capacity(1), 0, Duration.ofMillis(Integer.MAX_VALUE), 0).maxWait()).isEqualTo(Duration.ofMillis(2147483647L));
        assertThatThrownBy(() -> new AdmissionLimits(new Capacity(1), -1, Duration.ofSeconds(1), 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AdmissionLimits(new Capacity(1), 0, Duration.ofSeconds(1), -1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AdmissionLimits(new Capacity(1), 0, Duration.ZERO, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AdmissionLimits(new Capacity(1), 0, Duration.ofMillis(2147483648L), 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AdmissionLimits(null, 0, Duration.ofSeconds(1), 0)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("S2-SC-01 only a queued operation waits in the queue; its entry carries the version the claim is made against")
    void queueEntryComesFromAQueuedOperation() {
        Operation waiting = queued();
        QueuedOperation entry = QueuedOperation.of(waiting, 42);
        assertThat(entry.id()).isEqualTo(waiting.id());
        assertThat(entry.version()).isEqualTo(waiting.version());
        assertThat(entry.readySequence()).isEqualTo(42);
        assertThatThrownBy(() -> QueuedOperation.of(pending(), 1)).isInstanceOf(IllegalArgumentException.class);
    }
}
