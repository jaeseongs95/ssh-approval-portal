package io.github.jaeseongs95.portal.ssh.testkit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.time.Duration;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeoutException;
import org.apache.sshd.client.channel.ChannelExec;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.client.session.ClientSession.ClientSessionEvent;
import org.apache.sshd.common.config.keys.KeyUtils;
import org.apache.sshd.sftp.client.SftpClient;
import org.apache.sshd.sftp.client.SftpClientFactory;
import org.apache.sshd.sftp.common.SftpConstants;
import org.apache.sshd.sftp.common.SftpException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

/**
 * The test tool tests itself (cases S3-TK-01 .. S3-TK-14, new in stage 3): what the other portal-ssh tests rely on from {@link EmbeddedSshServer}, {@link SshTestClient},
 * {@link ScriptedCommand}, {@link SftpFault} and {@link EventLog}.
 */
@Timeout(120)
class EmbeddedSshServerTest {

    private static final String USER = "tester";
    private static final String PASSWORD = "secret";
    private static final Duration LIMIT = SshTestClient.LIMIT;

    @TempDir
    Path root;

    private SshTestClient client;
    private EmbeddedSshServer server;

    @BeforeEach
    void start() {
        client = SshTestClient.startAcceptingAnyHostKey();
    }

    @AfterEach
    void stop() throws IOException {
        client.close();
        if (server != null) {
            server.close();
        }
    }

    private SftpClient sftp(ClientSession session) throws IOException {
        return SftpClientFactory.instance().createSftpClient(session);
    }

    @Test
    @DisplayName("S3-TK-01 password login: the right password is accepted, a wrong one is refused, and both attempts are recorded without the secret")
    void passwordAuthentication() throws IOException {
        server = EmbeddedSshServer.builder().password(USER, PASSWORD).start();
        try (ClientSession session = client.open(server, USER, PASSWORD)) {
            assertThat(session.isOpen()).isTrue();
        }
        assertThatThrownBy(() -> client.open(server, USER, "wrong")).isInstanceOf(IOException.class);
        assertThat(server.authAttempts().snapshot()).contains(new AuthAttempt(USER, "password", true), new AuthAttempt(USER, "password", false));
        assertThat(server.authAttempts().snapshot()).extracting(AuthAttempt::toString).noneMatch(text -> text.contains(PASSWORD) || text.contains("wrong"));
    }

    @Test
    @DisplayName("S3-TK-02 public-key login: the registered key is accepted, another key is refused")
    void publicKeyAuthentication() throws IOException {
        KeyPair known = EmbeddedSshServer.newKeyPair();
        KeyPair other = EmbeddedSshServer.newKeyPair();
        server = EmbeddedSshServer.builder().publicKey(USER, known.getPublic()).start();
        try (ClientSession session = client.openWithKey(server, USER, known)) {
            assertThat(session.isOpen()).isTrue();
        }
        assertThatThrownBy(() -> client.openWithKey(server, USER, other)).isInstanceOf(IOException.class);
        assertThat(server.authAttempts().snapshot()).extracting(AuthAttempt::method).containsOnly("publickey");
    }

    @Test
    @DisplayName("S3-TK-03 the server presents the host key it was given, and its fingerprint is the one MINA prints")
    void hostKey() throws IOException {
        KeyPair hostKey = EmbeddedSshServer.newKeyPair();
        server = EmbeddedSshServer.builder().password(USER, PASSWORD).hostKey(hostKey).start();
        try (ClientSession session = client.open(server, USER, PASSWORD)) {
            assertThat(session.getServerKey()).isEqualTo(hostKey.getPublic());
            assertThat(KeyUtils.getFingerPrint(session.getServerKey())).isEqualTo(server.hostKeyFingerprint()).startsWith("SHA256:");
        }
    }

    @Test
    @DisplayName("S3-TK-04 scripted commands: exit status, stdout and stderr; an unscripted command exits 127; every request is counted")
    void scriptedCommands() throws Exception {
        server = EmbeddedSshServer.builder()
            .password(USER, PASSWORD)
            .script("echo hello", ScriptedCommand.exits(0, "hello\n", ""))
            .script("fail 3", ScriptedCommand.exits(3, "", "boom\n"))
            .start();
        try (ClientSession session = client.open(server, USER, PASSWORD)) {
            SshTestClient.ExecResult ok = client.exec(session, "echo hello", LIMIT);
            assertThat(ok.stdout()).isEqualTo("hello\n");
            assertThat(ok.exitStatus()).isZero();
            SshTestClient.ExecResult failed = client.exec(session, "fail 3", LIMIT);
            assertThat(failed.stderr()).isEqualTo("boom\n");
            assertThat(failed.exitStatus()).isEqualTo(3);
            SshTestClient.ExecResult unknown = client.exec(session, "nope", LIMIT);
            assertThat(unknown.exitStatus()).isEqualTo(127);
            assertThat(unknown.stderr()).contains("unknown command: nope");
        }
        assertThat(server.execRequestCount()).isEqualTo(3);
        assertThat(server.execRequests().snapshot()).containsExactly("echo hello", "fail 3", "nope");
        assertThat(server.destroyedCommands().await(3, LIMIT)).containsExactly("echo hello", "fail 3", "nope");
    }

    @Test
    @DisplayName("S3-TK-05 a large output arrives complete on both streams, with the exit status after it")
    void largeOutput() throws IOException {
        long stdoutBytes = 3_000_000;
        long stderrBytes = 1_000_000;
        server = EmbeddedSshServer.builder().password(USER, PASSWORD).script("big", ScriptedCommand.emitsBytes(stdoutBytes, stderrBytes, 0)).start();
        try (ClientSession session = client.open(server, USER, PASSWORD)) {
            SshTestClient.ExecResult result = client.exec(session, "big", Duration.ofSeconds(60));
            assertThat(result.stdout()).hasSize((int) stdoutBytes);
            assertThat(result.stdout().chars().allMatch(character -> character == 'x')).isTrue();
            assertThat(result.stderr()).hasSize((int) stderrBytes);
            assertThat(result.exitStatus()).isZero();
        }
    }

    @Test
    @DisplayName("S3-TK-06 dropConnections cuts every session without a disconnect message; the client sees its session closed")
    void dropConnections() throws Exception {
        server = EmbeddedSshServer.builder().password(USER, PASSWORD).start();
        try (ClientSession session = client.open(server, USER, PASSWORD)) {
            assertThat(server.activeSessionCount()).isEqualTo(1);
            assertThat(server.dropConnections()).isEqualTo(1);
            Set<ClientSessionEvent> events = session.waitFor(EnumSet.of(ClientSessionEvent.CLOSED), LIMIT);
            assertThat(events).contains(ClientSessionEvent.CLOSED);
            assertThat(session.isOpen()).isFalse();
        }
    }

    @Test
    @DisplayName("S3-TK-07 disconnectIdleSessions ends the session that has no channel and leaves the one that runs a command")
    void disconnectIdleSessions() throws Exception {
        server = EmbeddedSshServer.builder().password(USER, PASSWORD).script("hang", ScriptedCommand.hangs()).start();
        try (ClientSession idle = client.open(server, USER, PASSWORD); ClientSession busy = client.open(server, USER, PASSWORD);
            ChannelExec channel = client.startExec(busy, "hang")) {
            server.startedCommands().await(1, LIMIT);
            assertThat(server.disconnectIdleSessions()).isEqualTo(1);
            assertThat(idle.waitFor(EnumSet.of(ClientSessionEvent.CLOSED), LIMIT)).contains(ClientSessionEvent.CLOSED);
            assertThat(busy.isOpen()).isTrue();
            assertThat(channel.isOpen()).isTrue();
        }
    }

    @Test
    @DisplayName("S3-TK-08 SFTP on a temporary root: upload and download; posix-rename@openssh.com is advertised by default")
    void sftpRootAndDefaultExtensions() throws IOException {
        server = EmbeddedSshServer.builder().password(USER, PASSWORD).sftp(root).start();
        try (ClientSession session = client.open(server, USER, PASSWORD); SftpClient sftp = sftp(session)) {
            try (OutputStream out = sftp.write("/a.txt")) {
                out.write("abc".getBytes(StandardCharsets.UTF_8));
            }
            assertThat(Files.readString(root.resolve("a.txt"))).isEqualTo("abc");
            try (InputStream in = sftp.read("/a.txt")) {
                assertThat(new String(in.readAllBytes(), StandardCharsets.UTF_8)).isEqualTo("abc");
            }
            assertThat(sftp.getServerExtensions()).containsKey("posix-rename@openssh.com");
        }
        assertThat(server.sftpRoot()).contains(root);
    }

    @Test
    @DisplayName("S3-TK-09 SFTP with posix-rename@openssh.com hidden: the other extensions are still advertised")
    void sftpWithoutPosixRename() throws IOException {
        server = EmbeddedSshServer.builder().password(USER, PASSWORD).sftp(root).sftpAdvertisesPosixRename(false).start();
        try (ClientSession session = client.open(server, USER, PASSWORD); SftpClient sftp = sftp(session)) {
            assertThat(sftp.getServerExtensions()).doesNotContainKey("posix-rename@openssh.com").containsKey("fsync@openssh.com");
        }
    }

    @Test
    @DisplayName("S3-TK-10 an injected permission failure on opening for write fails the client with status 3, creates no file, fires once with times(1) and can be cleared")
    void permissionDeniedFault() throws IOException {
        server = EmbeddedSshServer.builder().password(USER, PASSWORD).sftp(root).start();
        try (ClientSession session = client.open(server, USER, PASSWORD); SftpClient sftp = sftp(session)) {
            server.injectSftpFault(SftpFault.of(SftpFault.Operation.OPEN_FOR_WRITE, "denied.bin", SftpFault.Failure.PERMISSION_DENIED).times(1));
            assertThatThrownBy(() -> {
                try (OutputStream out = sftp.write("/denied.bin")) {
                    out.write(1);
                }
            }).isInstanceOf(SftpException.class).hasFieldOrPropertyWithValue("status", SftpConstants.SSH_FX_PERMISSION_DENIED);
            assertThat(root.resolve("denied.bin")).doesNotExist();
            try (OutputStream out = sftp.write("/denied.bin")) {
                out.write(1);
            }
            assertThat(root.resolve("denied.bin")).exists();

            server.injectSftpFault(SftpFault.of(SftpFault.Operation.MKDIR, "locked", SftpFault.Failure.PERMISSION_DENIED));
            assertThatThrownBy(() -> sftp.mkdir("/locked")).isInstanceOf(SftpException.class).hasFieldOrPropertyWithValue("status", SftpConstants.SSH_FX_PERMISSION_DENIED);
            server.clearSftpFaults();
            sftp.mkdir("/locked");
            assertThat(root.resolve("locked")).isDirectory();
        }
    }

    @Test
    @DisplayName("S3-TK-11 an injected 'no space' failure in the middle of an upload fails the client with status 14 after at least the budget has been written")
    void noSpaceInTheMiddleOfAnUpload() throws IOException {
        server = EmbeddedSshServer.builder().password(USER, PASSWORD).sftp(root).start();
        try (ClientSession session = client.open(server, USER, PASSWORD); SftpClient sftp = sftp(session)) {
            server.injectSftpFault(SftpFault.of(SftpFault.Operation.OPEN_FOR_WRITE, "full.bin", SftpFault.Failure.NO_SPACE).afterBytes(100_000));
            assertThatThrownBy(() -> {
                try (OutputStream out = sftp.write("/full.bin")) {
                    out.write(new byte[500_000]);
                }
            }).isInstanceOf(SftpException.class).hasFieldOrPropertyWithValue("status", SftpConstants.SSH_FX_NO_SPACE_ON_FILESYSTEM);
            assertThat(Files.size(root.resolve("full.bin"))).isBetween(100_000L, 499_999L);
        }
    }

    @Test
    @DisplayName("S3-TK-12 an injected rename failure leaves the source in place and the client gets an SftpException")
    void renameFault() throws IOException {
        server = EmbeddedSshServer.builder().password(USER, PASSWORD).sftp(root).start();
        Files.writeString(root.resolve("a.tmp"), "new");
        try (ClientSession session = client.open(server, USER, PASSWORD); SftpClient sftp = sftp(session)) {
            server.injectSftpFault(SftpFault.of(SftpFault.Operation.RENAME, "b.txt", SftpFault.Failure.IO_ERROR));
            assertThatThrownBy(() -> sftp.rename("/a.tmp", "/b.txt")).isInstanceOf(SftpException.class);
            assertThat(root.resolve("a.tmp")).exists();
            assertThat(root.resolve("b.txt")).doesNotExist();
        }
    }

    @Test
    @DisplayName("S3-TK-13 a connection dropped in the middle of a download fails the read with an IOException and closes the client's session")
    void dropInTheMiddleOfADownload() throws Exception {
        server = EmbeddedSshServer.builder().password(USER, PASSWORD).sftp(root).start();
        Files.write(root.resolve("big.bin"), new byte[1_000_000]);
        try (ClientSession session = client.open(server, USER, PASSWORD)) {
            SftpClient sftp = sftp(session);
            server.injectSftpFault(SftpFault.of(SftpFault.Operation.OPEN_FOR_READ, "big.bin", SftpFault.Failure.CONNECTION_DROPPED).afterBytes(100_000));
            assertThatThrownBy(() -> {
                try (InputStream in = sftp.read("/big.bin")) {
                    in.readAllBytes();
                }
            }).isInstanceOf(IOException.class);
            assertThat(session.waitFor(EnumSet.of(ClientSessionEvent.CLOSED), LIMIT)).contains(ClientSessionEvent.CLOSED);
        }
    }

    @Test
    @DisplayName("S3-TK-14 the event log completes a waiter when the count is reached, and a wait that is not satisfied reports how many events it saw")
    void eventLog() throws Exception {
        EventLog<String> log = new EventLog<>();
        CompletableFuture<List<String>> waiter = log.whenAtLeast(2);
        log.add("one");
        assertThat(waiter.isDone()).isFalse();
        log.add("two");
        assertThat(waiter.isDone()).isTrue();
        assertThat(waiter.get()).isEqualTo(List.of("one", "two"));
        assertThat(log.whenAtLeast(1).isDone()).as("already satisfied").isTrue();
        assertThatThrownBy(() -> log.await(3, Duration.ofMillis(50))).isInstanceOf(TimeoutException.class).hasMessageContaining("saw 2");
    }
}
