package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.app.output.StreamFrame;
import io.github.jaeseongs95.portal.app.output.StreamKind;
import io.github.jaeseongs95.portal.app.remote.CancelToken;
import io.github.jaeseongs95.portal.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.app.remote.ExecutionTimeline;
import io.github.jaeseongs95.portal.app.remote.RemoteExecutor;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.error.ExecutionStage;
import io.github.jaeseongs95.portal.domain.error.RemoteOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.EnumSet;
import java.util.List;
import org.apache.sshd.client.SshClient;
import org.apache.sshd.client.channel.ChannelExec;
import org.apache.sshd.client.channel.ClientChannelEvent;
import org.apache.sshd.client.config.hosts.HostConfigEntryResolver;
import org.apache.sshd.client.keyverifier.KnownHostsServerKeyVerifier;
import org.apache.sshd.client.keyverifier.RejectAllServerKeyVerifier;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.common.keyprovider.FileKeyPairProvider;

/**
 * The real OpenSSH server of the {@code realOpenSshTest} task, as the file, platform and installer tests use it: one logged-in MINA session (the host key must be in the
 * known_hosts file, the identity is the key file, nothing else of the machine is read), the home directory of the account, a way to run a command on the server and a
 * {@link SessionSource} and a minimal {@link RemoteExecutor} over that session. The connection comes from the system properties {@code portal.test.openssh.*} that the Gradle
 * task sets (this is test code outside Spring; the product never reads them); a missing property fails the test. Nothing stands in for a missing server.
 *
 * <p>The {@link #isWindows()} answer lets a test choose the commands and the expectations of the server's system as data: no test is skipped by a condition.
 */
public final class RealServer implements AutoCloseable {

    private static final Duration LIMIT = Duration.ofSeconds(30);
    private static final String PREFIX = "portal.test.openssh.";

    private final SshClient client;
    private final ClientSession session;
    private final boolean windows;
    private final java.util.List<String> diagnostics = new java.util.concurrent.CopyOnWriteArrayList<>();

    /** Every command the executor of this server ran, with its exit code and output: a failing test puts this in its message. */
    public java.util.List<String> diagnostics() {
        return java.util.List.copyOf(diagnostics);
    }

    private RealServer(SshClient client, ClientSession session, boolean windows) {
        this.client = client;
        this.session = session;
        this.windows = windows;
    }

    /** Logs in to the server the Gradle properties describe. */
    public static RealServer open() throws IOException {
        SshClient client = SshClient.setUpDefaultClient();
        client.setServerKeyVerifier(new KnownHostsServerKeyVerifier(RejectAllServerKeyVerifier.INSTANCE, Path.of(required("known-hosts"))));
        client.setHostConfigEntryResolver(HostConfigEntryResolver.EMPTY);
        client.setKeyIdentityProvider(new FileKeyPairProvider(Path.of(required("key-file"))));
        client.start();
        try {
            ClientSession session = client.connect(required("user"), required("host"), Integer.parseInt(required("port"))).verify(LIMIT).getSession();
            session.auth().verify(LIMIT);
            return new RealServer(client, session, "windows".equals(required("platform")));
        } catch (IOException | RuntimeException e) {
            client.stop();
            throw e;
        }
    }

    private static String required(String name) {
        String value = System.getProperty(PREFIX + name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("the system property " + PREFIX + name + " is not set: run these tests with the Gradle task realOpenSshTest and its properties");
        }
        return value;
    }

    public ClientSession session() {
        return session;
    }

    public boolean isWindows() {
        return windows;
    }

    /** The home directory of the account as the SFTP server sees it: {@code /home/user} or {@code /C:/Users/user}. */
    public String sftpHome() throws IOException {
        try (org.apache.sshd.sftp.client.SftpClient sftp = new SftpChannels().open(session)) {
            return sftp.canonicalPath(".");
        }
    }

    /** A path in the home directory in the syntax of the server's system: the SFTP form of {@code /C:/Users/user/x} becomes {@code C:/Users/user/x}. */
    public RemotePath homePath(String relative) throws IOException {
        String text = sftpHome() + "/" + relative;
        return RemotePath.parse(windows ? text.substring(1) : text);
    }

    /** Runs a command on the server and returns its exit status and standard output. */
    public Result exec(String commandLine, byte[] stdin) throws IOException {
        try (ChannelExec channel = session.createExecChannel(commandLine)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            ByteArrayOutputStream err = new ByteArrayOutputStream();
            channel.setOut(out);
            channel.setErr(err);
            channel.setIn(new ByteArrayInputStream(stdin));
            channel.open().verify(LIMIT);
            channel.waitFor(EnumSet.of(ClientChannelEvent.CLOSED), LIMIT.toMillis());
            Integer status = channel.getExitStatus();
            return new Result(status == null ? -1 : status, out.toString(StandardCharsets.UTF_8), err.toString(StandardCharsets.UTF_8));
        }
    }

    public Result exec(String commandLine) throws IOException {
        return exec(commandLine, new byte[0]);
    }

    /** What a command printed and how it ended ({@code -1}: no exit status was seen). */
    public record Result(int exitStatus, String stdout, String stderr) {
    }

    /** A session source that hands out this session; closing a lease leaves it open. */
    public SessionSource sessions() {
        return (RemoteTarget target, CancelToken cancel) -> new SessionAcquisition.Acquired(new SessionLease() {
            @Override
            public ClientSession session() {
                return session;
            }

            @Override
            public void discard() {
                // the test owns the session
            }

            @Override
            public void close() {
                // the test owns the session
            }
        });
    }

    /** An executor over this session that runs one command at a time and sends each once; enough to run the fixed commands of the tests. */
    public RemoteExecutor executor() {
        return (request, sink, control) -> {
            try {
                Result result = exec(request.command().commandLine(), request.command().stdin().bytes());
                if (!result.stdout().isEmpty()) {
                    sink.accept(new StreamFrame(StreamKind.STDOUT, result.stdout().getBytes(StandardCharsets.UTF_8)));
                }
                if (!result.stderr().isEmpty()) {
                    sink.accept(new StreamFrame(StreamKind.STDERR, result.stderr().getBytes(StandardCharsets.UTF_8)));
                }
                String tail = result.stderr().length() > 1024 ? result.stderr().substring(result.stderr().length() - 1024) : result.stderr();
                diagnostics.add("exit " + result.exitStatus() + " of [" + request.command().commandLine() + "] stdout [" + result.stdout() + "] stderr [" + tail + "]");
                if (result.exitStatus() < 0) {
                    return lost();
                }
                return new ExecutionReport(ExecutionOutcome.exited(result.exitStatus(), List.of()), ExecutionTimeline.empty());
            } catch (IOException e) {
                return lost();
            }
        };
    }

    private ExecutionReport lost() {
        return new ExecutionReport(ExecutionOutcome.transportLost(new ExecutionFailure.Classified(ExecutionStage.SSH_EXECUTION, ExecutionErrorCode.SSH_EXECUTION_FAILED,
            RemoteOutcome.UNKNOWN), List.of()), ExecutionTimeline.empty());
    }

    @Override
    public void close() {
        client.stop();
    }
}
