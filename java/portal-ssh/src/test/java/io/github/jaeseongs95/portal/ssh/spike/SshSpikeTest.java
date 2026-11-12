package io.github.jaeseongs95.portal.ssh.spike;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.apache.sshd.client.SshClient;
import org.apache.sshd.client.channel.ChannelExec;
import org.apache.sshd.client.channel.ClientChannelEvent;
import org.apache.sshd.client.keyverifier.AcceptAllServerKeyVerifier;
import org.apache.sshd.client.keyverifier.DefaultKnownHostsServerKeyVerifier;
import org.apache.sshd.client.keyverifier.ServerKeyVerifier;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.common.file.virtualfs.VirtualFileSystemFactory;
import org.apache.sshd.common.keyprovider.KeyPairProvider;
import org.apache.sshd.server.Environment;
import org.apache.sshd.server.ExitCallback;
import org.apache.sshd.server.SshServer;
import org.apache.sshd.server.channel.ChannelSession;
import org.apache.sshd.server.command.Command;
import org.apache.sshd.sftp.client.SftpClient;
import org.apache.sshd.sftp.client.SftpClientFactory;
import org.apache.sshd.sftp.server.SftpSubsystemFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Spike (c), cases S-01 .. S-10 of docs/migration/foundation-cases.md: the MINA SSHD client against a MINA SshServer started inside the test (free port, in-memory host
 * key, a temporary root as the SFTP file system, password authentication). The exec commands are answered by a CommandFactory of the test, so no shell runs.
 * Nothing leaves the machine.
 */
class SshSpikeTest {

    private static final String USER = "tester";
    private static final String PASSWORD = "secret";
    private static final Duration LIMIT = Duration.ofSeconds(10);

    @TempDir
    Path root;

    private SshServer server;
    private SshClient client;
    private final CountDownLatch hangDestroyed = new CountDownLatch(1);

    /** A command the test server runs without a shell: the text of the command selects what it does. */
    private final class ScriptedCommand implements Command {
        private final String text;
        private OutputStream out;
        private OutputStream err;
        private ExitCallback exit;

        ScriptedCommand(String text) {
            this.text = text;
        }

        @Override
        public void setInputStream(InputStream in) {
        }

        @Override
        public void setOutputStream(OutputStream out) {
            this.out = out;
        }

        @Override
        public void setErrorStream(OutputStream err) {
            this.err = err;
        }

        @Override
        public void setExitCallback(ExitCallback callback) {
            this.exit = callback;
        }

        @Override
        public void start(ChannelSession channel, Environment env) throws IOException {
            switch (text) {
                case "echo hello" -> {
                    out.write("hello\n".getBytes(StandardCharsets.UTF_8));
                    out.flush();
                    exit.onExit(0);
                }
                case "fail 3" -> {
                    err.write("boom\n".getBytes(StandardCharsets.UTF_8));
                    err.flush();
                    exit.onExit(3);
                }
                case "hang" -> {
                    // Never exits by itself: only the end of the channel (destroy) ends it.
                }
                default -> {
                    err.write(("unknown command: " + text + "\n").getBytes(StandardCharsets.UTF_8));
                    err.flush();
                    exit.onExit(127);
                }
            }
        }

        @Override
        public void destroy(ChannelSession channel) {
            if ("hang".equals(text)) {
                hangDestroyed.countDown();
            }
        }
    }

    private static KeyPair newKeyPair() throws NoSuchAlgorithmException {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(256);
        return generator.generateKeyPair();
    }

    private SshServer startServer(int port, KeyPair hostKey) throws IOException {
        SshServer started = SshServer.setUpDefaultServer();
        started.setHost("127.0.0.1");
        started.setPort(port);
        started.setKeyPairProvider(KeyPairProvider.wrap(hostKey));
        started.setPasswordAuthenticator((user, password, session) -> USER.equals(user) && PASSWORD.equals(password));
        started.setFileSystemFactory(new VirtualFileSystemFactory(root));
        started.setSubsystemFactories(List.of(new SftpSubsystemFactory()));
        started.setCommandFactory((channel, command) -> new ScriptedCommand(command));
        started.start();
        return started;
    }

    private SshClient startClient(ServerKeyVerifier verifier) {
        SshClient started = SshClient.setUpDefaultClient();
        started.setServerKeyVerifier(verifier);
        started.start();
        return started;
    }

    private ClientSession open(String password) throws IOException {
        ClientSession session = client.connect(USER, "127.0.0.1", server.getPort()).verify(LIMIT).getSession();
        session.addPasswordIdentity(password);
        session.auth().verify(LIMIT);
        return session;
    }

    @BeforeEach
    void start() throws Exception {
        server = startServer(0, newKeyPair());
        client = startClient(AcceptAllServerKeyVerifier.INSTANCE);
    }

    @AfterEach
    void stop() throws IOException {
        client.stop();
        server.stop(true);
    }

    private record ExecResult(String stdout, String stderr, Integer exitStatus, Set<ClientChannelEvent> events) {
    }

    private ExecResult exec(ClientSession session, String command, Duration limit) throws IOException {
        try (ChannelExec channel = session.createExecChannel(command)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            ByteArrayOutputStream err = new ByteArrayOutputStream();
            channel.setOut(out);
            channel.setErr(err);
            channel.open().verify(LIMIT);
            Set<ClientChannelEvent> events = channel.waitFor(EnumSet.of(ClientChannelEvent.CLOSED), limit.toMillis());
            return new ExecResult(out.toString(StandardCharsets.UTF_8), err.toString(StandardCharsets.UTF_8), channel.getExitStatus(), events);
        }
    }

    @Test
    void s01_execReturnsStdoutAndExitCodeZero() throws IOException {
        try (ClientSession session = open(PASSWORD)) {
            ExecResult result = exec(session, "echo hello", LIMIT);
            assertThat(result.stdout()).isEqualTo("hello\n");
            assertThat(result.stderr()).isEmpty();
            assertThat(result.exitStatus()).isEqualTo(0);
        }
    }

    @Test
    void s02_execKeepsStderrApartAndReturnsTheExitCode() throws IOException {
        try (ClientSession session = open(PASSWORD)) {
            ExecResult result = exec(session, "fail 3", LIMIT);
            assertThat(result.stdout()).isEmpty();
            assertThat(result.stderr()).isEqualTo("boom\n");
            assertThat(result.exitStatus()).isEqualTo(3);
        }
    }

    @Test
    void s03_aCommandThatOutlivesItsLimitIsEndedByClosingTheChannel() throws Exception {
        try (ClientSession session = open(PASSWORD); ChannelExec channel = session.createExecChannel("hang")) {
            channel.open().verify(LIMIT);
            Set<ClientChannelEvent> events = channel.waitFor(EnumSet.of(ClientChannelEvent.CLOSED), Duration.ofSeconds(1).toMillis());
            assertThat(events).as("the limit expired before the command ended").contains(ClientChannelEvent.TIMEOUT).doesNotContain(ClientChannelEvent.CLOSED);
            assertThat(hangDestroyed.getCount()).as("the server has not ended the command yet").isEqualTo(1);
            channel.close(false).await(LIMIT);
            assertThat(channel.isOpen()).isFalse();
            assertThat(hangDestroyed.await(10, TimeUnit.SECONDS)).as("closing the channel reaches the server command: destroy() was called").isTrue();
            assertThat(channel.getExitStatus()).as("no exit status: the command never exited").isNull();
        }
    }

    @Test
    void s04_sftpUploadWritesTheBytesIntoTheServerRoot() throws IOException {
        byte[] bytes = new byte[1024 * 1024];
        new Random(7).nextBytes(bytes);
        try (ClientSession session = open(PASSWORD); SftpClient sftp = SftpClientFactory.instance().createSftpClient(session)) {
            sftp.mkdir("/up");
            try (OutputStream out = sftp.write("/up/a.bin")) {
                out.write(bytes);
            }
        }
        assertThat(Files.readAllBytes(root.resolve("up/a.bin"))).isEqualTo(bytes);
    }

    @Test
    void s05_sftpDownloadReturnsTheBytes() throws IOException {
        byte[] bytes = new byte[300_000];
        new Random(11).nextBytes(bytes);
        Files.createDirectories(root.resolve("down"));
        Files.write(root.resolve("down/b.bin"), bytes);
        try (ClientSession session = open(PASSWORD); SftpClient sftp = SftpClientFactory.instance().createSftpClient(session);
            InputStream in = sftp.read("/down/b.bin")) {
            assertThat(in.readAllBytes()).isEqualTo(bytes);
        }
    }

    @Test
    void s06_aTemporaryFileReplacesTheTargetByRename() throws IOException {
        Files.write(root.resolve("b.txt"), "old".getBytes(StandardCharsets.UTF_8));
        try (ClientSession session = open(PASSWORD); SftpClient sftp = SftpClientFactory.instance().createSftpClient(session)) {
            try (OutputStream out = sftp.write("/b.txt.tmp")) {
                out.write("new".getBytes(StandardCharsets.UTF_8));
            }
            // The advertised extensions of the server decide whether an atomic replace by posix-rename is possible. docs/sftp.md lists the extension as "only client side",
            // yet the MINA 2.20.1 server advertises it (observed by this test), so against this server the client can use the extension.
            Map<String, byte[]> extensions = sftp.getServerExtensions();
            assertThat(extensions.keySet()).as("extensions advertised by the MINA SFTP server").contains("posix-rename@openssh.com");
            sftp.rename("/b.txt.tmp", "/b.txt", SftpClient.CopyMode.Overwrite);
        }
        assertThat(Files.readString(root.resolve("b.txt"))).isEqualTo("new");
        assertThat(root.resolve("b.txt.tmp")).doesNotExist();
    }

    @Test
    void s07_theFirstHostKeyIsRecordedAndTheSameKeyIsAcceptedAgain() throws Exception {
        Path knownHosts = root.resolveSibling(root.getFileName() + "-known_hosts");
        client.stop();
        client = startClient(new DefaultKnownHostsServerKeyVerifier(AcceptAllServerKeyVerifier.INSTANCE, true, knownHosts));
        assertThat(knownHosts).doesNotExist();
        try (ClientSession session = open(PASSWORD)) {
            assertThat(session.isOpen()).isTrue();
        }
        List<String> recorded = Files.readAllLines(knownHosts);
        assertThat(recorded).as("the first key seen is written to known_hosts").hasSize(1);
        assertThat(recorded.get(0)).contains("ecdsa-sha2-nistp256");
        try (ClientSession session = open(PASSWORD)) {
            assertThat(session.isOpen()).isTrue();
        }
        assertThat(Files.readAllLines(knownHosts)).as("the same key adds nothing").isEqualTo(recorded);
    }

    @Test
    void s08_aChangedHostKeyIsRefusedAndTheRecordStaysAsItWas() throws Exception {
        Path knownHosts = root.resolveSibling(root.getFileName() + "-known_hosts-changed");
        client.stop();
        client = startClient(new DefaultKnownHostsServerKeyVerifier(AcceptAllServerKeyVerifier.INSTANCE, true, knownHosts));
        int port = server.getPort();
        try (ClientSession session = open(PASSWORD)) {
            assertThat(session.isOpen()).isTrue();
        }
        List<String> recorded = Files.readAllLines(knownHosts);
        server.stop(true);
        // The same address now presents another host key.
        server = startServer(port, newKeyPair());
        assertThat(server.getPort()).isEqualTo(port);
        assertThatThrownBy(() -> open(PASSWORD)).as("a connection to a host whose key changed is refused").isInstanceOf(IOException.class);
        assertThat(Files.readAllLines(knownHosts)).as("a refused key is not recorded").isEqualTo(recorded);
    }

    @Test
    void s09_aWrongPasswordFailsTheAuthentication() {
        assertThatThrownBy(() -> open("wrong")).isInstanceOf(IOException.class);
    }
}
