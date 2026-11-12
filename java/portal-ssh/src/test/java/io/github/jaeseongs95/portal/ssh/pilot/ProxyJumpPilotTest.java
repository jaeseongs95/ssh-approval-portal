package io.github.jaeseongs95.portal.ssh.pilot;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.ssh.testkit.AuthAttempt;
import io.github.jaeseongs95.portal.ssh.testkit.EmbeddedSshServer;
import io.github.jaeseongs95.portal.ssh.testkit.ScriptedCommand;
import io.github.jaeseongs95.portal.ssh.testkit.SshTestClient;
import io.github.jaeseongs95.portal.ssh.testkit.SshTestClient.ExecResult;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.security.PublicKey;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import org.apache.sshd.client.channel.ChannelDirectTcpip;
import org.apache.sshd.client.config.hosts.HostConfigEntry;
import org.apache.sshd.client.keyverifier.ServerKeyVerifier;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.client.session.forward.ExplicitPortForwardingTracker;
import org.apache.sshd.common.config.keys.KeyUtils;
import org.apache.sshd.common.session.Session;
import org.apache.sshd.common.session.SessionListener;
import org.apache.sshd.common.util.net.SshdSocketAddress;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/**
 * Pilot P3-5 of docs/migration/stage3-design.md (3.6 ProxyJump, decision for the session code): two MINA test servers, a jump host and a target behind it, each with its own
 * credential and host key. Two ways to reach the target are tried:
 *
 * <ol>
 * <li>(a) the MINA chain: {@code HostConfigEntry.setProxyJump} on the target entry, one {@code SshClient}. MINA authenticates the jump hop itself and hands back an unauthenticated
 * session to the target. The questions: how does each hop get its own credential, and what does the one client-wide {@code ServerKeyVerifier} see?</li>
 * <li>(b) the explicit way: one {@code SshClient} per hop, each with its own verifier; the jump session forwards a loopback port to the target
 * ({@code ClientSession.createLocalPortForwardingTracker}, built on direct-tcpip channels) and the second client connects to that port. The raw
 * {@code createDirectTcpipChannel} is tried too: it carries the target's SSH bytes, but MINA 2.20.1 has no public API that runs a client session on such a channel.</li>
 * </ol>
 */
@Timeout(120)
class ProxyJumpPilotTest {

    private static final String JUMP_USER = "jumper";
    private static final String JUMP_PASSWORD = "jump-secret";
    private static final String TARGET_USER = "tgt";
    private static final String TARGET_PASSWORD = "target-secret";
    private static final Duration LIMIT = SshTestClient.LIMIT;

    /** What the one client-wide verifier was asked: the address MINA reports and the fingerprint of the key it was shown. */
    private record Verified(int port, String fingerprint) {
    }

    /** Captures the first line the target writes on a raw direct-tcpip channel (its SSH identification string). */
    private static final class BannerCapture extends OutputStream {
        private final StringBuilder line = new StringBuilder();
        private final CompletableFuture<String> firstLine = new CompletableFuture<>();

        @Override
        public void write(int b) {
            if (firstLine.isDone()) {
                return;
            }
            if (b == '\n') {
                firstLine.complete(line.toString().stripTrailing());
            } else {
                line.append((char) b);
            }
        }

        @Override
        public void write(byte[] buffer, int offset, int length) {
            for (int i = offset; i < offset + length; i++) {
                write(buffer[i] & 0xff);
            }
        }
    }

    private EmbeddedSshServer jump;
    private EmbeddedSshServer target;

    @BeforeEach
    void start() throws IOException {
        jump = EmbeddedSshServer.builder().password(JUMP_USER, JUMP_PASSWORD).allowTcpForwarding().start();
        target = EmbeddedSshServer.builder().password(TARGET_USER, TARGET_PASSWORD).script("echo hello", ScriptedCommand.exits(0, "hello\n", "")).start();
    }

    @AfterEach
    void stop() throws IOException {
        target.close();
        jump.close();
    }

    private static ServerKeyVerifier pinnedTo(PublicKey expected) {
        return (session, address, key) -> KeyUtils.compareKeys(key, expected);
    }

    /** The jump hop's password is set per session by a listener that recognises the jump server by its port: MINA's chain has no per-hop credential setting of its own. */
    private void credentialByPort(SshTestClient client, String jumpPassword) {
        client.sshClient().addSessionListener(new SessionListener() {
            @Override
            public void sessionCreated(Session session) {
                if (session instanceof ClientSession clientSession && SshdSocketAddress.toAddressPort(session.getRemoteAddress()) == jump.port()) {
                    clientSession.addPasswordIdentity(jumpPassword);
                }
            }
        });
    }

    private ClientSession connectThroughTheChain(SshTestClient client) throws IOException {
        HostConfigEntry entry = new HostConfigEntry("target", EmbeddedSshServer.HOST, target.port(), TARGET_USER);
        entry.setProxyJump(JUMP_USER + "@" + EmbeddedSshServer.HOST + ":" + jump.port());
        ClientSession session = client.sshClient().connect(entry).verify(LIMIT).getSession();
        session.addPasswordIdentity(TARGET_PASSWORD);
        session.auth().verify(LIMIT);
        return session;
    }

    @Test
    @DisplayName("P3-5 (a) HostConfigEntry chain: the jump hop and the target authenticate with their own credentials, each only at its own server")
    void theChainGivesEachHopItsOwnCredential() throws Exception {
        try (SshTestClient client = SshTestClient.startAcceptingAnyHostKey()) {
            credentialByPort(client, JUMP_PASSWORD);
            try (ClientSession session = connectThroughTheChain(client)) {
                ExecResult result = client.exec(session, "echo hello", LIMIT);
                assertThat(result.stdout()).isEqualTo("hello\n");
                assertThat(result.exitStatus()).isZero();
            }
        }
        assertThat(target.execRequests().snapshot()).containsExactly("echo hello");
        assertThat(jump.execRequests().snapshot()).as("the jump host ran nothing: it only forwarded").isEmpty();
        assertThat(jump.forwardRequests().snapshot()).containsExactly(new SshdSocketAddress(EmbeddedSshServer.HOST, target.port()));
        assertThat(jump.authAttempts().snapshot()).filteredOn(AuthAttempt::accepted).extracting(AuthAttempt::user).containsExactly(JUMP_USER);
        assertThat(target.authAttempts().snapshot()).filteredOn(AuthAttempt::accepted).extracting(AuthAttempt::user).containsExactly(TARGET_USER);
        assertThat(jump.authAttempts().snapshot()).as("the jump server never saw the target's user or password").extracting(AuthAttempt::user).containsOnly(JUMP_USER);
        assertThat(target.authAttempts().snapshot()).as("the target never saw the jump's user or password").extracting(AuthAttempt::user).containsOnly(TARGET_USER);
    }

    @Test
    @DisplayName("P3-5 (a) HostConfigEntry chain: the one client-wide ServerKeyVerifier is asked about the jump address and then about the TARGET address (MINA sets the TARGET_SERVER attribute: AbstractClientSession.checkKeys), so a verifier can pin per hop by address")
    void theChainShowsTheVerifierTheForwardingPortInsteadOfTheTarget() throws Exception {
        List<Verified> asked = new CopyOnWriteArrayList<>();
        ServerKeyVerifier recording = (session, address, key) -> {
            asked.add(new Verified(SshdSocketAddress.toAddressPort(address), KeyUtils.getFingerPrint(key)));
            return true;
        };
        try (SshTestClient client = SshTestClient.start(recording)) {
            credentialByPort(client, JUMP_PASSWORD);
            try (ClientSession session = connectThroughTheChain(client)) {
                assertThat(session.isOpen()).isTrue();
            }
        }
        assertThat(asked).hasSize(2);
        assertThat(asked.get(0)).isEqualTo(new Verified(jump.port(), jump.hostKeyFingerprint()));
        // Observed on the first run: the second address is the target's own port, not the loopback forwarding port. The source says why: checkKeys replaces the remote
        // address with the TARGET_SERVER attribute that SshClient sets on the target session right after it is connected (a listener on the connect future, so it is set
        // before the key exchange has produced the server key, but it is not ordered by an API contract).
        assertThat(asked.get(1)).isEqualTo(new Verified(target.port(), target.hostKeyFingerprint()));
    }

    @Test
    @DisplayName("P3-5 (a) HostConfigEntry chain: a wrong credential for the jump hop fails the connect with an IOException and the target is never contacted")
    void aWrongJumpCredentialFailsTheChainBeforeTheTarget() throws Exception {
        try (SshTestClient client = SshTestClient.startAcceptingAnyHostKey()) {
            credentialByPort(client, "not-the-jump-password");
            assertThatThrownBy(() -> connectThroughTheChain(client)).isInstanceOf(IOException.class);
        }
        assertThat(jump.authAttempts().snapshot()).extracting(AuthAttempt::accepted).doesNotContain(true);
        assertThat(target.authAttempts().snapshot()).isEmpty();
        assertThat(target.activeSessionCount()).isZero();
    }

    @Test
    @DisplayName("P3-5 (b) one client per hop: each hop has its own host key verifier and credential, and the second session runs over a port forwarded by the first")
    void twoClientsGiveEachHopItsOwnVerifierAndCredential() throws Exception {
        try (SshTestClient jumpClient = SshTestClient.start(pinnedTo(jump.hostPublicKey()));
            SshTestClient targetClient = SshTestClient.start(pinnedTo(target.hostPublicKey()));
            ClientSession jumpSession = jumpClient.open(jump, JUMP_USER, JUMP_PASSWORD);
            ExplicitPortForwardingTracker tracker = jumpSession.createLocalPortForwardingTracker(SshdSocketAddress.LOCALHOST_ADDRESS,
                new SshdSocketAddress(EmbeddedSshServer.HOST, target.port()));
            ClientSession targetSession = targetClient.open(EmbeddedSshServer.HOST, tracker.getBoundAddress().getPort(), TARGET_USER, TARGET_PASSWORD)) {
            ExecResult result = targetClient.exec(targetSession, "echo hello", LIMIT);
            assertThat(result.stdout()).isEqualTo("hello\n");
            assertThat(targetSession.getServerKey()).as("the key the target presented, seen through the forwarded port").isEqualTo(target.hostPublicKey());
        }
        assertThat(target.execRequests().snapshot()).containsExactly("echo hello");
        assertThat(jump.execRequests().snapshot()).isEmpty();
        assertThat(jump.forwardRequests().snapshot()).containsExactly(new SshdSocketAddress(EmbeddedSshServer.HOST, target.port()));
        assertThat(jump.authAttempts().snapshot()).extracting(AuthAttempt::user).containsOnly(JUMP_USER);
        assertThat(target.authAttempts().snapshot()).extracting(AuthAttempt::user).containsOnly(TARGET_USER);
    }

    @Test
    @DisplayName("P3-5 (b) one client per hop: a verifier pinned to the jump's key refuses the target behind it")
    void aVerifierPinnedToTheWrongHopRefusesTheTarget() throws Exception {
        try (SshTestClient jumpClient = SshTestClient.start(pinnedTo(jump.hostPublicKey()));
            SshTestClient wrongClient = SshTestClient.start(pinnedTo(jump.hostPublicKey()));
            ClientSession jumpSession = jumpClient.open(jump, JUMP_USER, JUMP_PASSWORD);
            ExplicitPortForwardingTracker tracker = jumpSession.createLocalPortForwardingTracker(SshdSocketAddress.LOCALHOST_ADDRESS,
                new SshdSocketAddress(EmbeddedSshServer.HOST, target.port()))) {
            int boundPort = tracker.getBoundAddress().getPort();
            assertThatThrownBy(() -> wrongClient.open(EmbeddedSshServer.HOST, boundPort, TARGET_USER, TARGET_PASSWORD)).isInstanceOf(IOException.class);
        }
        assertThat(target.authAttempts().snapshot()).as("the target saw no login: the host key was refused first").isEmpty();
    }

    @Test
    @DisplayName("P3-5 (b) a raw createDirectTcpipChannel on the jump session carries the target's SSH identification string")
    void aRawDirectTcpipChannelCarriesTheTargetsSshBytes() throws Exception {
        try (SshTestClient jumpClient = SshTestClient.start(pinnedTo(jump.hostPublicKey()));
            ClientSession jumpSession = jumpClient.open(jump, JUMP_USER, JUMP_PASSWORD);
            ChannelDirectTcpip channel = jumpSession.createDirectTcpipChannel(SshdSocketAddress.LOCALHOST_ADDRESS, new SshdSocketAddress(EmbeddedSshServer.HOST, target.port()))) {
            BannerCapture banner = new BannerCapture();
            channel.setOut(banner);
            channel.open().verify(LIMIT);
            assertThat(banner.firstLine.get(LIMIT.toSeconds(), TimeUnit.SECONDS)).startsWith("SSH-2.0-");
        }
        assertThat(jump.forwardRequests().snapshot()).containsExactly(new SshdSocketAddress(EmbeddedSshServer.HOST, target.port()));
    }

    @Test
    @DisplayName("P3-5 a jump server that refuses forwarding makes the forwarded port unusable and the refusal is recorded")
    void aJumpHostThatRefusesForwardingBlocksTheTarget() throws Exception {
        try (EmbeddedSshServer closedJump = EmbeddedSshServer.builder().password(JUMP_USER, JUMP_PASSWORD).start();
            SshTestClient jumpClient = SshTestClient.start(pinnedTo(closedJump.hostPublicKey()));
            SshTestClient targetClient = SshTestClient.start(pinnedTo(target.hostPublicKey()));
            ClientSession jumpSession = jumpClient.open(closedJump, JUMP_USER, JUMP_PASSWORD);
            ExplicitPortForwardingTracker tracker = jumpSession.createLocalPortForwardingTracker(SshdSocketAddress.LOCALHOST_ADDRESS,
                new SshdSocketAddress(EmbeddedSshServer.HOST, target.port()))) {
            int boundPort = tracker.getBoundAddress().getPort();
            assertThatThrownBy(() -> targetClient.open(EmbeddedSshServer.HOST, boundPort, TARGET_USER, TARGET_PASSWORD)).isInstanceOf(IOException.class);
            assertThat(closedJump.forwardRequests().await(1, LIMIT)).containsExactly(new SshdSocketAddress(EmbeddedSshServer.HOST, target.port()));
        }
        assertThat(target.authAttempts().snapshot()).isEmpty();
    }

    @Test
    @DisplayName("P3-5 the recorded verifier address of a direct connection is the server's own port")
    void aDirectConnectionIsVerifiedAtItsOwnAddress() throws Exception {
        List<InetSocketAddress> asked = new CopyOnWriteArrayList<>();
        ServerKeyVerifier recording = (session, address, key) -> {
            asked.add(SshdSocketAddress.toInetSocketAddress(address));
            return true;
        };
        try (SshTestClient client = SshTestClient.start(recording); ClientSession session = client.open(target, TARGET_USER, TARGET_PASSWORD)) {
            assertThat(session.isOpen()).isTrue();
        }
        assertThat(asked).hasSize(1);
        assertThat(asked.get(0).getPort()).isEqualTo(target.port());
    }
}
