package io.github.jaeseongs95.portal.ssh.hostkey;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import io.github.jaeseongs95.portal.app.remote.HostKeyMode;
import io.github.jaeseongs95.portal.app.remote.SshSettings;
import io.github.jaeseongs95.portal.domain.target.Setting;
import io.github.jaeseongs95.portal.ssh.profile.TestFiles;
import io.github.jaeseongs95.portal.ssh.testkit.EmbeddedSshServer;

/**
 * What the product logs about host keys (decision D3-10: the insecure mode warns when the product starts). The test reads what the logger of {@link LoggingHostKeyEvents}
 * receives, through a Logback list appender: the one log line per event is asserted, so a refusal is not logged twice (once by the policy and once by the events).
 */
class LoggingHostKeyEventsTest {

    @TempDir
    Path root;

    private Logger logger;
    private ListAppender<ILoggingEvent> appender;

    @BeforeEach
    void listenToTheLogger() {
        logger = (Logger) LoggerFactory.getLogger(LoggingHostKeyEvents.class);
        appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
    }

    @AfterEach
    void stopListening() {
        logger.detachAppender(appender);
        appender.stop();
    }

    private SshSettings settings(HostKeyMode mode, Path knownHosts) {
        SshSettings defaults = SshSettings.defaults(knownHosts);
        return new SshSettings(defaults.connectTimeout(), defaults.heartbeatInterval(), defaults.heartbeatNoReplyMax(), defaults.idleProbeAfter(), defaults.execReplyTimeout(),
            defaults.channelPermits(), defaults.consecutiveOpenRejections(), mode, knownHosts);
    }

    @Test
    @DisplayName("D3-10: building the policy in insecure mode logs one WARN that says every host key is accepted")
    void insecureModeIsAWarningAtStart() throws IOException {
        Path knownHosts = TestFiles.privateFolder(Files.createDirectory(root.resolve("state"))).resolve("known_hosts");

        new ServerKeyPolicy(settings(HostKeyMode.INSECURE, knownHosts), TestFiles.guard(), new LoggingHostKeyEvents());

        assertThat(appender.list).singleElement().satisfies(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.WARN);
            assertThat(event.getFormattedMessage()).contains("insecure").contains("every host key is accepted");
        });
    }

    @Test
    @DisplayName("D3-10: the tofu and strict modes log nothing when the policy is built")
    void theOtherModesAreSilentAtStart() throws IOException {
        Path knownHosts = TestFiles.privateFolder(Files.createDirectory(root.resolve("state"))).resolve("known_hosts");

        new ServerKeyPolicy(settings(HostKeyMode.TOFU, knownHosts), TestFiles.guard(), new LoggingHostKeyEvents());
        new ServerKeyPolicy(settings(HostKeyMode.STRICT, knownHosts), TestFiles.guard(), new LoggingHostKeyEvents());

        assertThat(appender.list).isEmpty();
    }

    @Test
    @DisplayName("VR-445, D3-10: a refused key is logged once, at WARN, with the code, the address and the fingerprints")
    void aRefusalIsOneLine() {
        KeyPair received = EmbeddedSshServer.newKeyPair();
        HostKeyRefusal refusal = new HostKeyRefusal(HostKeyRefusal.Reason.PIN_MISMATCH, "host.example.test", 22, HostKeyFingerprint.of(received.getPublic()),
            Setting.given("SHA256:pinned"));

        new LoggingHostKeyEvents().refused(refusal);

        assertThat(appender.list).singleElement().satisfies(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.WARN);
            assertThat(event.getFormattedMessage()).contains("HOST_KEY_PIN_MISMATCH").contains("host.example.test:22").contains("SHA256:pinned")
                .contains(HostKeyFingerprint.of(received.getPublic()).text());
        });
    }
}
