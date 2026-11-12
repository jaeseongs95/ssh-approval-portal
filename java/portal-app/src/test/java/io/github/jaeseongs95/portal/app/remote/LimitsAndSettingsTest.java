package io.github.jaeseongs95.portal.app.remote;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Path;
import java.time.Duration;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.util.unit.DataSize;

import io.github.jaeseongs95.portal.domain.operation.UploadInput;

/** The invariants of the limit and settings values of the SSH ports (stage 3 design 2.2, 3.4, 3.5; decisions D3-06, D3-07). */
class LimitsAndSettingsTest {

    @Test
    @DisplayName("S3-EX-02 S3-EX-06 the default execution limits are the 2.x values: 120 seconds, a grace of 5 seconds and 1 MiB per stream")
    void executionDefaultsAreTheTwoXValues() {
        ExecutionLimits defaults = ExecutionLimits.defaults();
        assertThat(defaults.deadline()).isEqualTo(Duration.ofMillis(120_000));
        assertThat(defaults.stopGrace()).isEqualTo(Duration.ofMillis(5_000));
        assertThat(defaults.outputPerStream()).isEqualTo(DataSize.ofBytes(1024 * 1024));
    }

    @Test
    @DisplayName("S3-EX-02 an execution limit below 1 millisecond or above 2^31-1 milliseconds is refused, and so is an output cap outside 1 to 2^31-1 bytes")
    void executionLimitsAreBounded() {
        DataSize cap = DataSize.ofKilobytes(1);
        assertThatThrownBy(() -> new ExecutionLimits(Duration.ZERO, Duration.ofSeconds(1), cap)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ExecutionLimits(Duration.ofNanos(999_999), Duration.ofSeconds(1), cap)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ExecutionLimits(Duration.ofSeconds(1), Duration.ofMillis(Integer.MAX_VALUE + 1L), cap)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ExecutionLimits(Duration.ofSeconds(1), Duration.ofSeconds(1), DataSize.ofBytes(0))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ExecutionLimits(Duration.ofSeconds(1), Duration.ofSeconds(1), DataSize.ofBytes(Integer.MAX_VALUE + 1L)))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ExecutionLimits(null, Duration.ofSeconds(1), cap)).isInstanceOf(NullPointerException.class);
        ExecutionLimits edge = new ExecutionLimits(Duration.ofMillis(1), Duration.ofMillis(Integer.MAX_VALUE), DataSize.ofBytes(Integer.MAX_VALUE));
        assertThat(edge.deadline()).isEqualTo(Duration.ofMillis(1));
    }

    @Test
    @DisplayName("S3-SF-07 a transfer holds at most the 64 MiB of the contract and takes the deadline rule of an execution")
    void transferLimitsAreBounded() {
        TransferLimits defaults = TransferLimits.defaults();
        assertThat(defaults.deadline()).isEqualTo(Duration.ofSeconds(120));
        assertThat(defaults.maxFileSize().toBytes()).isEqualTo(UploadInput.MAX_BYTES);
        assertThat(new TransferLimits(Duration.ofSeconds(1), DataSize.ofBytes(1)).maxFileSize().toBytes()).isEqualTo(1);
        assertThatThrownBy(() -> new TransferLimits(Duration.ofSeconds(1), DataSize.ofBytes(UploadInput.MAX_BYTES + 1))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TransferLimits(Duration.ofSeconds(1), DataSize.ofBytes(0))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TransferLimits(Duration.ZERO, DataSize.ofBytes(1))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S3-SS-06 S3-SS-11 D3-07 the session defaults are the 2.x values: connect 20 s, heartbeat 15 s three times, probe after 10 s, exec reply 10 s, 8 channels, 3 refusals")
    void sshSettingsDefaultsAreTheTwoXValues() {
        Path knownHosts = Path.of("known-hosts-for-the-test");
        SshSettings settings = SshSettings.defaults(knownHosts);
        assertThat(settings.connectTimeout()).isEqualTo(Duration.ofSeconds(20));
        assertThat(settings.heartbeatInterval()).isEqualTo(Duration.ofSeconds(15));
        assertThat(settings.heartbeatNoReplyMax()).isEqualTo(3);
        assertThat(settings.idleProbeAfter()).isEqualTo(Duration.ofSeconds(10));
        assertThat(settings.execReplyTimeout()).isEqualTo(Duration.ofSeconds(10));
        assertThat(settings.channelPermits()).isEqualTo(8);
        assertThat(settings.consecutiveOpenRejections()).isEqualTo(3);
        assertThat(settings.hostKeyMode()).isEqualTo(HostKeyMode.TOFU);
        assertThat(settings.knownHosts()).isEqualTo(knownHosts);
    }

    @Test
    @DisplayName("S3-SS-06 S3-SS-11 a session setting that is not positive is refused, and the known hosts path is an argument, not a default")
    void sshSettingsAreChecked() {
        Path path = Path.of("known-hosts-for-the-test");
        Duration one = Duration.ofSeconds(1);
        assertThatThrownBy(() -> new SshSettings(Duration.ZERO, one, 3, one, one, 8, 3, HostKeyMode.TOFU, path)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new SshSettings(one, one.negated(), 3, one, one, 8, 3, HostKeyMode.TOFU, path)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new SshSettings(one, one, 0, one, one, 8, 3, HostKeyMode.TOFU, path)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new SshSettings(one, one, 3, one, one, 0, 3, HostKeyMode.TOFU, path)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new SshSettings(one, one, 3, one, one, 8, 0, HostKeyMode.TOFU, path)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new SshSettings(one, one, 3, one, one, 8, 3, null, path)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new SshSettings(one, one, 3, one, one, 8, 3, HostKeyMode.STRICT, null)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> SshSettings.defaults(null)).isInstanceOf(NullPointerException.class);
    }
}
