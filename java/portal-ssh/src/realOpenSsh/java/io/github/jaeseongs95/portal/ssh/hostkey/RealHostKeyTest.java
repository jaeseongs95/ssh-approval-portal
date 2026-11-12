package io.github.jaeseongs95.portal.ssh.hostkey;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.PublicKey;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;

import org.apache.sshd.client.SshClient;
import org.apache.sshd.client.config.hosts.HostConfigEntryResolver;
import org.apache.sshd.client.config.hosts.KnownHostEntry;
import org.apache.sshd.client.keyverifier.ServerKeyVerifier;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.common.keyprovider.FileKeyPairProvider;
import org.junit.jupiter.api.AfterEach;
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
import io.github.jaeseongs95.portal.ssh.profile.AclFileAccessRule;
import io.github.jaeseongs95.portal.ssh.profile.FileAccessGuard;
import io.github.jaeseongs95.portal.ssh.profile.PosixFileAccessRule;

/**
 * Host key checks against the real OpenSSH server that the CI job prepares (stage 3 design 7.2, decision D3-10; the connection is described by the Gradle properties
 * {@code portal.test.openssh.*} of the task {@code realOpenSshTest}). What the embedded MINA server cannot show: the fingerprint of the key of a real {@code sshd} is the
 * one that {@code ssh-keyscan} wrote to the known_hosts file of the target, and the policy accepts that host in strict mode and by pin. A connection counts as accepted only
 * when the key exchange ran and the login with the key file of the target worked (see {@code connect}); a refusal counts only when the policy reported it. Nothing is skipped when the server is missing: the test fails
 * with a message that names the property.
 */
class RealHostKeyTest {

    private static final Duration LIMIT = Duration.ofSeconds(30);

    @TempDir
    Path root;

    private final List<SshClient> clients = new ArrayList<>();
    /** What the policy refused, so that a failed connection is known to be a refused host key and not another failure (a login problem, a closed port). */
    private final List<HostKeyRefusal> refusals = new CopyOnWriteArrayList<>();

    @AfterEach
    void stopTheClients() {
        clients.forEach(SshClient::stop);
    }

    private String property(String name) {
        String value = System.getProperty("portal.test.openssh." + name);
        assertThat(value).as("the system property portal.test.openssh." + name + " (set by the task realOpenSshTest)").isNotBlank();
        return value;
    }

    private ConnectionProfile profile(Setting<String> pin) {
        return new ConnectionProfile(property("host"), Integer.parseInt(property("port")), property("user"), pin, Setting.unset(), AuthMethod.KEY, Setting.unset(),
            Setting.unset(), AccessMode.READ_WRITE, TtyMode.NO_TTY);
    }

    /**
     * Connects and logs in with the key file of the target; the connection is closed again with the client. The connect future of MINA completes when the TCP connection
     * stands, <em>before</em> the key exchange, so the host key has not been checked yet at that point (a first version of this test stopped there and saw no check at all).
     * The key exchange, and with it the host key check, is part of what {@code auth().verify} waits for: it returns only when the host key was accepted and the login worked,
     * and it throws when the verifier refused the key.
     */
    private void connect(ServerKeyVerifier verifier) throws IOException {
        SshClient client = SshClient.setUpDefaultClient();
        client.setServerKeyVerifier(verifier);
        client.setHostConfigEntryResolver(HostConfigEntryResolver.EMPTY);
        client.setKeyIdentityProvider(new FileKeyPairProvider(Path.of(property("key-file"))));
        client.start();
        clients.add(client);
        try (ClientSession session = client.connect(property("user"), property("host"), Integer.parseInt(property("port"))).verify(LIMIT).getSession()) {
            session.auth().verify(LIMIT);
            assertThat(session.isAuthenticated()).as("the host key was accepted and the login with the key file worked").isTrue();
        }
    }

    /** The fingerprints of the keys in the known_hosts file of the target, computed from the Base64 field of each line (the SSH wire form of the key). */
    private List<String> fingerprintsInKnownHosts() throws IOException {
        // MINA parses the known_hosts lines; the key data of an entry is the blob of the Base64 field, so this does not go through the PublicKey of the policy.
        return KnownHostEntry.readKnownHostEntries(Path.of(property("known-hosts"))).stream()
            .map(entry -> HostKeyFingerprint.ofBlob(entry.getKeyEntry().getKeyData()).text())
            .toList();
    }

    private ServerKeyPolicy policyOverACopyOfTheRecord(HostKeyMode mode, boolean copyTheRecord) throws IOException {
        FileAccessGuard guard = new FileAccessGuard(List.of(new PosixFileAccessRule(), new AclFileAccessRule()));
        Path copy = root.resolve("private-state").resolve("known_hosts");
        guard.createPrivateFile(copy);
        if (copyTheRecord) {
            // Written into the private file the guard made (a copy by Files.copy would make a new file with the default rights).
            Files.writeString(copy, Files.readString(Path.of(property("known-hosts"))));
        }
        SshSettings defaults = SshSettings.defaults(copy);
        SshSettings settings = new SshSettings(defaults.connectTimeout(), defaults.heartbeatInterval(), defaults.heartbeatNoReplyMax(), defaults.idleProbeAfter(),
            defaults.execReplyTimeout(), defaults.channelPermits(), defaults.consecutiveOpenRejections(), mode, copy);
        return new ServerKeyPolicy(settings, guard, new HostKeyEvents() {
            @Override
            public void refused(HostKeyRefusal refusal) {
                refusals.add(refusal);
            }

            @Override
            public void insecureModeActive() {
                // not used here: no test of this class builds the insecure mode
            }
        });
    }

    /** The key the server presents, as the MINA client receives it. */
    private PublicKey presentedKey() throws IOException {
        AtomicReference<PublicKey> presented = new AtomicReference<>();
        connect((session, remoteAddress, serverKey) -> {
            presented.set(serverKey);
            return true;
        });
        return presented.get();
    }

    @Test
    @DisplayName("VR-436, VR-437 (real server): the fingerprint of the key that the server presents is the fingerprint of one of the keys of its known_hosts line")
    void theFingerprintIsTheOneOfTheKnownHostsLine() throws IOException {
        PublicKey presented = presentedKey();

        assertThat(presented).as("the verifier was asked: the key exchange ran").isNotNull();
        assertThat(fingerprintsInKnownHosts()).contains(HostKeyFingerprint.of(presented).text());
    }

    @Test
    @DisplayName("VR-447, D3-10 (real server): strict mode accepts the host that the known_hosts file holds")
    void strictModeAcceptsTheRecordedServer() throws IOException {
        ServerKeyPolicy policy = policyOverACopyOfTheRecord(HostKeyMode.STRICT, true);

        connect(policy.verifierFor(profile(Setting.unset())));

        assertThat(refusals).isEmpty();
    }

    @Test
    @DisplayName("VR-447, D3-10 (real server): strict mode refuses the host when nothing is recorded")
    void strictModeRefusesAnUnrecordedServer() throws IOException {
        ServerKeyPolicy policy = policyOverACopyOfTheRecord(HostKeyMode.STRICT, false);

        assertThatThrownBy(() -> connect(policy.verifierFor(profile(Setting.unset())))).isInstanceOf(IOException.class);

        assertThat(refusals).singleElement().satisfies(refusal -> assertThat(refusal.reason()).isEqualTo(HostKeyRefusal.Reason.UNKNOWN));
    }

    @Test
    @DisplayName("VR-438, VR-439 (real server): the pin of the key that the server presents is accepted, and a pin of another key is refused")
    void aPinIsComparedWithTheRealKey() throws IOException {
        String pin = HostKeyFingerprint.of(presentedKey()).text();
        ServerKeyPolicy policy = policyOverACopyOfTheRecord(HostKeyMode.TOFU, false);

        connect(policy.verifierFor(profile(Setting.given(pin))));

        String other = pin.substring(0, pin.length() - 1) + (pin.endsWith("A") ? "B" : "A");
        assertThat(refusals).isEmpty();
        assertThatThrownBy(() -> connect(policy.verifierFor(profile(Setting.given(other))))).isInstanceOf(IOException.class);

        assertThat(refusals).singleElement().satisfies(refusal -> assertThat(refusal.reason()).isEqualTo(HostKeyRefusal.Reason.PIN_MISMATCH));
    }
}
