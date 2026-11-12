package io.github.jaeseongs95.portal.ssh.hostkey;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.KeyPair;
import java.util.List;

import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.common.config.keys.PublicKeyEntry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import io.github.jaeseongs95.portal.app.remote.HostKeyMode;
import io.github.jaeseongs95.portal.app.remote.SshSettings;
import io.github.jaeseongs95.portal.domain.target.AccessMode;
import io.github.jaeseongs95.portal.domain.target.AuthMethod;
import io.github.jaeseongs95.portal.domain.target.ConnectionProfile;
import io.github.jaeseongs95.portal.domain.target.Setting;
import io.github.jaeseongs95.portal.domain.target.TtyMode;
import io.github.jaeseongs95.portal.ssh.profile.AccessVerdict;
import io.github.jaeseongs95.portal.ssh.profile.ProfileConfigException;
import io.github.jaeseongs95.portal.ssh.profile.Protection;
import io.github.jaeseongs95.portal.ssh.profile.TestFiles;
import io.github.jaeseongs95.portal.ssh.testkit.EmbeddedSshServer;
import io.github.jaeseongs95.portal.ssh.testkit.SshTestClient;

/**
 * The host key policy against a real MINA client and the embedded MINA server of the test kit (stage 3 design 3.6, decision D3-10; vendor CR-18 to CR-23, cases VR-438 to
 * VR-451 of vendor-ssh-mcp-rules.md, section 5.6). The record of known hosts is a real {@code known_hosts} file in a private folder; a refused key is a refused connection.
 * The expectations were traced from vendor ssh/host-key.js; where 3.0 differs (a record on disk, blank pin, mode as a type) the test says so.
 */
class ServerKeyPolicyTest {

    private static final String USER = "tester";
    private static final String PASSWORD = "secret";

    @TempDir
    Path root;

    private Path knownHosts;
    private RecordingHostKeyEvents events;

    @BeforeEach
    void aPrivateFolderForTheRecord() throws IOException {
        knownHosts = TestFiles.privateFolder(Files.createDirectory(root.resolve("state"))).resolve("known_hosts");
        events = new RecordingHostKeyEvents();
    }

    private SshSettings settings(HostKeyMode mode) {
        SshSettings defaults = SshSettings.defaults(knownHosts);
        return new SshSettings(defaults.connectTimeout(), defaults.heartbeatInterval(), defaults.heartbeatNoReplyMax(), defaults.idleProbeAfter(), defaults.execReplyTimeout(),
            defaults.channelPermits(), defaults.consecutiveOpenRejections(), mode, knownHosts);
    }

    private ServerKeyPolicy policy(HostKeyMode mode) {
        return new ServerKeyPolicy(settings(mode), TestFiles.guard(), events);
    }

    private EmbeddedSshServer server(KeyPair hostKey) throws IOException {
        return EmbeddedSshServer.builder().hostKey(hostKey).password(USER, PASSWORD).start();
    }

    private ConnectionProfile profile(EmbeddedSshServer server, Setting<String> pin) {
        return new ConnectionProfile(server.host(), server.port(), USER, pin, Setting.unset(), AuthMethod.PASSWORD, Setting.unset(), Setting.unset(), AccessMode.READ_WRITE,
            TtyMode.NO_TTY);
    }

    private Setting<String> pinOf(KeyPair key) {
        return Setting.given(HostKeyFingerprint.of(key.getPublic()).text());
    }

    /** Connects and logs in with the verifier the policy gives for the profile; the connection is closed again. */
    private void connect(ServerKeyPolicy policy, EmbeddedSshServer server, ConnectionProfile profile) throws IOException {
        try (SshTestClient client = SshTestClient.start(policy.verifierFor(profile)); ClientSession session = client.open(server, USER, PASSWORD)) {
            assertThat(session.isOpen()).isTrue();
        }
    }

    private void assertRefused(ServerKeyPolicy policy, EmbeddedSshServer server, ConnectionProfile profile) {
        assertThatThrownBy(() -> connect(policy, server, profile)).as("a connection whose host key is refused").isInstanceOf(IOException.class);
    }

    /** Puts the line of a host and a key in the file, as an operator or an earlier run would have. */
    private void recordHost(EmbeddedSshServer server, KeyPair key) throws IOException {
        Files.writeString(knownHosts, "[" + server.host() + "]:" + server.port() + " " + PublicKeyEntry.toString(key.getPublic()) + "\n");
    }

    @Test
    @DisplayName("VR-438: a pinned key that matches is accepted in tofu mode, and the host is recorded when it was not")
    void aMatchingPinIsRecordedInTofuMode() throws IOException {
        KeyPair hostKey = EmbeddedSshServer.newKeyPair();
        try (EmbeddedSshServer server = server(hostKey)) {
            connect(policy(HostKeyMode.TOFU), server, profile(server, pinOf(hostKey)));

            List<String> lines = Files.readAllLines(knownHosts);
            assertThat(lines).hasSize(1);
            assertThat(lines.get(0)).startsWith("[" + server.host() + "]:" + server.port()).contains(PublicKeyEntry.toString(hostKey.getPublic()));
            assertThat(events.refusals()).isEmpty();
        }
    }

    @Test
    @DisplayName("VR-439: a pin that does not match is refused even in insecure mode, with HOST_KEY_PIN_MISMATCH, and nothing is recorded")
    void aWrongPinIsRefusedInEveryMode() throws IOException {
        KeyPair hostKey = EmbeddedSshServer.newKeyPair();
        KeyPair pinned = EmbeddedSshServer.newKeyPair();
        try (EmbeddedSshServer server = server(hostKey)) {
            assertRefused(policy(HostKeyMode.INSECURE), server, profile(server, pinOf(pinned)));

            assertThat(events.refusals()).singleElement().satisfies(refusal -> {
                assertThat(refusal.reason()).isEqualTo(HostKeyRefusal.Reason.PIN_MISMATCH);
                assertThat(refusal.reason().code()).isEqualTo("HOST_KEY_PIN_MISMATCH");
                assertThat(refusal.host()).isEqualTo(server.host());
                assertThat(refusal.port()).isEqualTo(server.port());
                assertThat(refusal.received()).isEqualTo(HostKeyFingerprint.of(hostKey.getPublic()));
                assertThat(refusal.expected()).isEqualTo(pinOf(pinned));
            });
            assertThat(knownHosts).as("insecure mode keeps no record").doesNotExist();
        }
    }

    @Test
    @DisplayName("VR-440: a pinned key that matches is accepted in strict mode, and nothing is recorded")
    void aMatchingPinIsNotRecordedInStrictMode() throws IOException {
        KeyPair hostKey = EmbeddedSshServer.newKeyPair();
        try (EmbeddedSshServer server = server(hostKey)) {
            connect(policy(HostKeyMode.STRICT), server, profile(server, pinOf(hostKey)));

            assertThat(Files.readAllLines(knownHosts)).isEmpty();
        }
    }

    @Test
    @DisplayName("VR-441: a pinned key that matches is accepted when the record holds another key for the host, and the record keeps what it had")
    void aMatchingPinFillsButNeverOverwritesTheRecord() throws IOException {
        KeyPair hostKey = EmbeddedSshServer.newKeyPair();
        KeyPair recorded = EmbeddedSshServer.newKeyPair();
        try (EmbeddedSshServer server = server(hostKey)) {
            ServerKeyPolicy policy = policy(HostKeyMode.TOFU);
            recordHost(server,recorded);
            List<String> before = Files.readAllLines(knownHosts);

            connect(policy, server, profile(server, pinOf(hostKey)));

            assertThat(Files.readAllLines(knownHosts)).isEqualTo(before);
            assertThat(events.refusals()).as("what the record says is not the business of a pinned connection").isEmpty();
        }
    }

    @Test
    @DisplayName("VR-442: the pin did not put its key in the record, so a profile without a pin finds the other key and is refused with HOST_KEY_MISMATCH")
    void aProfileWithoutAPinSeesTheRecord() throws IOException {
        KeyPair hostKey = EmbeddedSshServer.newKeyPair();
        KeyPair recorded = EmbeddedSshServer.newKeyPair();
        try (EmbeddedSshServer server = server(hostKey)) {
            ServerKeyPolicy policy = policy(HostKeyMode.TOFU);
            recordHost(server,recorded);
            connect(policy, server, profile(server, pinOf(hostKey)));

            assertRefused(policy, server, profile(server, Setting.unset()));

            assertThat(events.refusals()).singleElement().satisfies(refusal -> {
                assertThat(refusal.reason().code()).isEqualTo("HOST_KEY_MISMATCH");
                assertThat(refusal.received()).isEqualTo(HostKeyFingerprint.of(hostKey.getPublic()));
                assertThat(refusal.expected()).isEqualTo(Setting.given(HostKeyFingerprint.of(recorded.getPublic()).text()));
            });
        }
    }

    @Test
    @DisplayName("VR-443 (2.x와 다름: 2.x took an empty pin for no pin, which silently turns pinning off; a blank pin is a configuration error): the policy refuses to build a verifier for it")
    void aBlankPinIsNotNoPin() throws IOException {
        try (EmbeddedSshServer server = server(EmbeddedSshServer.newKeyPair())) {
            ServerKeyPolicy policy = policy(HostKeyMode.TOFU);

            assertThatThrownBy(() -> policy.verifierFor(profile(server, Setting.given("   ")))).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    @DisplayName("VR-444: in insecure mode every key is accepted, also one that differs from the record, and the record does not change")
    void insecureModeAcceptsEveryKey() throws IOException {
        KeyPair hostKey = EmbeddedSshServer.newKeyPair();
        try (EmbeddedSshServer server = server(hostKey)) {
            recordHost(server,EmbeddedSshServer.newKeyPair());
            List<String> before = Files.readAllLines(knownHosts);

            connect(policy(HostKeyMode.INSECURE), server, profile(server, Setting.unset()));

            assertThat(Files.readAllLines(knownHosts)).isEqualTo(before);
            assertThat(events.refusals()).isEmpty();
        }
    }

    @Test
    @DisplayName("VR-445: in tofu mode a key that differs from the record is refused with HOST_KEY_MISMATCH, both fingerprints are reported, and the record does not change")
    void aChangedKeyIsRefused() throws IOException {
        KeyPair hostKey = EmbeddedSshServer.newKeyPair();
        KeyPair recorded = EmbeddedSshServer.newKeyPair();
        try (EmbeddedSshServer server = server(hostKey)) {
            ServerKeyPolicy policy = policy(HostKeyMode.TOFU);
            recordHost(server,recorded);
            List<String> before = Files.readAllLines(knownHosts);

            assertRefused(policy, server, profile(server, Setting.unset()));

            assertThat(Files.readAllLines(knownHosts)).isEqualTo(before);
            assertThat(events.refusals()).singleElement().satisfies(refusal -> {
                assertThat(refusal.reason()).isEqualTo(HostKeyRefusal.Reason.CHANGED);
                assertThat(refusal.reason().code()).isEqualTo("HOST_KEY_MISMATCH");
                assertThat(refusal.expected()).isEqualTo(Setting.given(HostKeyFingerprint.of(recorded.getPublic()).text()));
                assertThat(refusal.received()).isEqualTo(HostKeyFingerprint.of(hostKey.getPublic()));
                assertThat(refusal.describe()).contains("HOST_KEY_MISMATCH").contains("expected SHA256:").contains("received SHA256:");
            });
        }
    }

    @Test
    @DisplayName("VR-446: in tofu mode the recorded key is accepted again, and the record does not change")
    void theRecordedKeyIsAcceptedAgain() throws IOException {
        KeyPair hostKey = EmbeddedSshServer.newKeyPair();
        try (EmbeddedSshServer server = server(hostKey)) {
            recordHost(server,hostKey);
            List<String> before = Files.readAllLines(knownHosts);

            connect(policy(HostKeyMode.TOFU), server, profile(server, Setting.unset()));

            assertThat(Files.readAllLines(knownHosts)).isEqualTo(before);
            assertThat(events.refusals()).isEmpty();
        }
    }

    @Test
    @DisplayName("VR-447: in strict mode a host that is not recorded is refused with HOST_KEY_UNKNOWN, and nothing is recorded")
    void strictModeRefusesAnUnknownHost() throws IOException {
        try (EmbeddedSshServer server = server(EmbeddedSshServer.newKeyPair())) {
            assertRefused(policy(HostKeyMode.STRICT), server, profile(server, Setting.unset()));

            assertThat(events.refusals()).singleElement().satisfies(refusal -> {
                assertThat(refusal.reason()).isEqualTo(HostKeyRefusal.Reason.UNKNOWN);
                assertThat(refusal.reason().code()).isEqualTo("HOST_KEY_UNKNOWN");
                assertThat(refusal.expected().isGiven()).isFalse();
            });
            assertThat(Files.readAllLines(knownHosts)).isEmpty();
        }
    }

    @Test
    @DisplayName("VR-447: in strict mode a host that is recorded is accepted")
    void strictModeAcceptsARecordedHost() throws IOException {
        KeyPair hostKey = EmbeddedSshServer.newKeyPair();
        try (EmbeddedSshServer server = server(hostKey)) {
            recordHost(server,hostKey);

            connect(policy(HostKeyMode.STRICT), server, profile(server, Setting.unset()));

            assertThat(events.refusals()).isEmpty();
        }
    }

    @Test
    @DisplayName("VR-448, VR-451: the default mode is tofu, and the first key of a host is recorded")
    void theDefaultModeRecordsTheFirstKey() throws IOException {
        assertThat(SshSettings.defaults(knownHosts).hostKeyMode()).isEqualTo(HostKeyMode.TOFU);
        KeyPair hostKey = EmbeddedSshServer.newKeyPair();
        try (EmbeddedSshServer server = server(hostKey)) {
            connect(new ServerKeyPolicy(SshSettings.defaults(knownHosts), TestFiles.guard(), events), server, profile(server, Setting.unset()));

            assertThat(Files.readAllLines(knownHosts)).singleElement().asString().contains(PublicKeyEntry.toString(hostKey.getPublic()));
        }
    }

    @Test
    @DisplayName("VR-449, VR-450 (2.x와 다름: 2.x took an unknown mode like tofu; a typo in the mode must not weaken the check, so the type has three values and an unknown spelling is refused where the setting is read)")
    void theModeIsOneOfThree() {
        assertThat(HostKeyMode.values()).containsExactly(HostKeyMode.TOFU, HostKeyMode.STRICT, HostKeyMode.INSECURE);
        assertThatThrownBy(() -> HostKeyMode.valueOf("WEIRD")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("D3-10 (s07): a key that was trusted stays trusted when the policy is built again, as after a restart")
    void theRecordSurvivesARestart() throws IOException {
        KeyPair hostKey = EmbeddedSshServer.newKeyPair();
        try (EmbeddedSshServer server = server(hostKey)) {
            connect(policy(HostKeyMode.TOFU), server, profile(server, Setting.unset()));
            List<String> recorded = Files.readAllLines(knownHosts);
            assertThat(recorded).hasSize(1);

            connect(policy(HostKeyMode.STRICT), server, profile(server, Setting.unset()));

            assertThat(Files.readAllLines(knownHosts)).as("the same key adds nothing").isEqualTo(recorded);
        }
    }

    @Test
    @DisplayName("D3-10 (s08): a host that comes back with another key after a restart is refused, and the record stays as it was")
    void aChangedKeyAfterARestartIsRefused() throws IOException {
        EmbeddedSshServer first = server(EmbeddedSshServer.newKeyPair());
        int port = first.port();
        List<String> recorded;
        try (first) {
            connect(policy(HostKeyMode.TOFU), first, profile(first, Setting.unset()));
            recorded = Files.readAllLines(knownHosts);
        }

        try (EmbeddedSshServer second = EmbeddedSshServer.builder().port(port).hostKey(EmbeddedSshServer.newKeyPair()).password(USER, PASSWORD).start()) {
            assertThat(second.port()).isEqualTo(port);
            assertRefused(policy(HostKeyMode.TOFU), second, profile(second, Setting.unset()));

            assertThat(Files.readAllLines(knownHosts)).isEqualTo(recorded);
            assertThat(events.refusals()).singleElement().satisfies(refusal -> assertThat(refusal.reason()).isEqualTo(HostKeyRefusal.Reason.CHANGED));
        }
    }

    @Test
    @DisplayName("D3-10: the file and its folder are made when they are missing, and only the owner can use them")
    void theFileIsCreatedPrivate() throws IOException {
        Path missingFolder = root.resolve("created-by-the-policy");
        Path file = missingFolder.resolve("known_hosts");

        new ServerKeyPolicy(new SshSettings(SshSettings.DEFAULT_CONNECT_TIMEOUT, SshSettings.DEFAULT_HEARTBEAT_INTERVAL, SshSettings.DEFAULT_HEARTBEAT_NO_REPLY_MAX,
            SshSettings.DEFAULT_IDLE_PROBE_AFTER, SshSettings.DEFAULT_EXEC_REPLY_TIMEOUT, SshSettings.DEFAULT_CHANNEL_PERMITS, SshSettings.DEFAULT_CONSECUTIVE_OPEN_REJECTIONS,
            HostKeyMode.TOFU, file), TestFiles.guard(), events);

        assertThat(file).exists();
        assertThat(TestFiles.guard().inspect(file, Protection.NO_OTHER_ACCESS)).as("the file and its folder, even for reading").isInstanceOf(AccessVerdict.Private.class);
        if (TestFiles.hasPermissionBits(file)) {
            assertThat(Files.getPosixFilePermissions(file)).isEqualTo(PosixFilePermissions.fromString("rw-------"));
            assertThat(Files.getPosixFilePermissions(missingFolder)).isEqualTo(PosixFilePermissions.fromString("rwx------"));
        }
    }

    @Test
    @DisplayName("D3-10: a file of known hosts that other accounts may change is refused when the policy is built")
    void aFileOthersMayChangeIsRefused() throws IOException {
        Files.writeString(knownHosts, "");
        TestFiles.openToWrite(knownHosts);

        assertThatThrownBy(() -> policy(HostKeyMode.TOFU)).isInstanceOfSatisfying(ProfileConfigException.class, e -> assertThat(e.code()).isEqualTo(ProfileConfigException.Code.KNOWN_HOSTS_UNSAFE))
            .hasMessageContaining("not safe to trust");
    }

    @Test
    @DisplayName("D3-10: the insecure mode is reported once when the policy is built, and the other modes say nothing")
    void insecureModeIsReported() {
        policy(HostKeyMode.TOFU);
        policy(HostKeyMode.STRICT);
        assertThat(events.insecureReports()).isZero();

        policy(HostKeyMode.INSECURE);

        assertThat(events.insecureReports()).isEqualTo(1);
    }
}
