package io.github.jaeseongs95.portal.ssh.testkit;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.time.Duration;
import java.util.EnumSet;
import java.util.Set;
import org.apache.sshd.client.SshClient;
import org.apache.sshd.client.channel.ChannelExec;
import org.apache.sshd.client.channel.ClientChannelEvent;
import org.apache.sshd.client.config.hosts.HostConfigEntryResolver;
import org.apache.sshd.client.keyverifier.AcceptAllServerKeyVerifier;
import org.apache.sshd.client.keyverifier.ServerKeyVerifier;
import org.apache.sshd.client.session.ClientSession;

/**
 * A MINA SSH client for the tests of this module, wired the way a test needs it: started, with a stated host key verifier, and without any file of the machine
 * ({@code ~/.ssh/config} lookups are switched off). It is not the product's client: the product's session code has its own tests.
 */
public final class SshTestClient implements AutoCloseable {

    /** The limit for connecting, authenticating and opening a channel in the tests. */
    public static final Duration LIMIT = Duration.ofSeconds(10);

    /** What {@link #exec(ClientSession, String, Duration)} saw. {@code exitStatus} is null when the server sent none; {@code events} are the channel events when the wait ended. */
    public record ExecResult(String stdout, String stderr, Integer exitStatus, Set<ClientChannelEvent> events) {
    }

    private final SshClient client;

    private SshTestClient(SshClient client) {
        this.client = client;
    }

    /** Starts a client that asks {@code verifier} about every server key. */
    public static SshTestClient start(ServerKeyVerifier verifier) {
        SshClient created = SshClient.setUpDefaultClient();
        created.setServerKeyVerifier(verifier);
        created.setHostConfigEntryResolver(HostConfigEntryResolver.EMPTY);
        created.start();
        return new SshTestClient(created);
    }

    /** Starts a client that trusts every host key (for tests that are not about host keys). */
    public static SshTestClient startAcceptingAnyHostKey() {
        return start(AcceptAllServerKeyVerifier.INSTANCE);
    }

    /** The MINA client, for what this class does not wrap. */
    public SshClient sshClient() {
        return client;
    }

    /** Connects to the server and authenticates with a password; the caller closes the session. */
    public ClientSession open(EmbeddedSshServer server, String user, String password) throws IOException {
        return open(server.host(), server.port(), user, password);
    }

    /** Connects to {@code host:port} and authenticates with a password; the caller closes the session. */
    public ClientSession open(String host, int port, String user, String password) throws IOException {
        ClientSession session = client.connect(user, host, port).verify(LIMIT).getSession();
        session.addPasswordIdentity(password);
        session.auth().verify(LIMIT);
        return session;
    }

    /** Connects to the server and authenticates with a key pair; the caller closes the session. */
    public ClientSession openWithKey(EmbeddedSshServer server, String user, KeyPair key) throws IOException {
        ClientSession session = client.connect(user, server.host(), server.port()).verify(LIMIT).getSession();
        session.addPublicKeyIdentity(key);
        session.auth().verify(LIMIT);
        return session;
    }

    /** Runs the command to its end (or to the limit) and collects its output; the channel is closed before returning. */
    public ExecResult exec(ClientSession session, String command, Duration limit) throws IOException {
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

    /** Opens an exec channel whose output is discarded and returns it without waiting for the command: for commands that do not end by themselves. The caller closes it. */
    public ChannelExec startExec(ClientSession session, String command) throws IOException {
        ChannelExec channel = session.createExecChannel(command);
        channel.setOut(OutputStream.nullOutputStream());
        channel.setErr(OutputStream.nullOutputStream());
        channel.open().verify(LIMIT);
        return channel;
    }

    /** Stops the client and closes every session it made. */
    @Override
    public void close() {
        client.stop();
    }
}
