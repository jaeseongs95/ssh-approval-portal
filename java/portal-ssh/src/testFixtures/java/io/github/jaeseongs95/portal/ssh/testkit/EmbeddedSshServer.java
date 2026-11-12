package io.github.jaeseongs95.portal.ssh.testkit;

import java.io.IOException;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.NoSuchAlgorithmException;
import java.security.PublicKey;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import java.util.stream.Collectors;
import org.apache.sshd.common.SshConstants;
import org.apache.sshd.common.channel.Channel;
import org.apache.sshd.common.channel.ChannelListener;
import org.apache.sshd.common.channel.RequestHandler;
import org.apache.sshd.common.config.keys.KeyUtils;
import org.apache.sshd.common.file.virtualfs.VirtualFileSystemFactory;
import org.apache.sshd.common.keyprovider.KeyPairProvider;
import org.apache.sshd.common.session.ConnectionService;
import org.apache.sshd.common.session.Session;
import org.apache.sshd.common.session.SessionListener;
import org.apache.sshd.common.session.helpers.AbstractSession;
import org.apache.sshd.common.util.net.SshdSocketAddress;
import org.apache.sshd.server.ServerBuilder;
import org.apache.sshd.server.SshServer;
import org.apache.sshd.server.forward.AgentForwardingFilter;
import org.apache.sshd.server.forward.ForwardingFilter;
import org.apache.sshd.server.forward.TcpForwardingFilter;
import org.apache.sshd.server.forward.X11ForwardingFilter;
import org.apache.sshd.sftp.SftpModuleProperties;
import org.apache.sshd.sftp.common.extensions.openssh.PosixRenameExtensionParser;
import org.apache.sshd.sftp.server.AbstractSftpSubsystemHelper;
import org.apache.sshd.sftp.server.SftpSubsystemFactory;
import org.springframework.core.task.SimpleAsyncTaskExecutor;

/**
 * A MINA SSH server that runs inside the test JVM on a free loopback port: the shared test tool of the portal-ssh tests (stage 3 design 7.1). Nothing leaves the machine and
 * no shell runs: exec commands are {@link ScriptedCommand}s looked up by their exact text.
 *
 * <p>What it offers: password and public-key authentication; a chosen host key; fake exec commands (exit codes, stdout and stderr, never-ending commands, large output,
 * commands that end on a signal); a record of every exec request, signal, authentication attempt and forwarding request ({@link EventLog}, waited on without polling);
 * closing idle sessions or all connections on demand; an SFTP subsystem on a temporary root that can hide the {@code posix-rename@openssh.com} extension and inject
 * failures ({@link SftpFault}); TCP forwarding for two-server ProxyJump tests.
 *
 * <p>Create it with {@link #builder()}; closing it stops the server. The MINA server is thread-safe; so are the recording and the switches of this class.
 */
public final class EmbeddedSshServer implements AutoCloseable {

    /** The address the server listens on. */
    public static final String HOST = "127.0.0.1";

    private static final Duration DROP_LIMIT = Duration.ofSeconds(10);

    private final SshServer server;
    private final KeyPair hostKey;
    private final Path sftpRoot;
    private final SimpleAsyncTaskExecutor executor = new SimpleAsyncTaskExecutor("embedded-ssh-");
    private final Map<String, ScriptedCommand> scripts = new ConcurrentHashMap<>();
    private final Set<Channel> openChannels = ConcurrentHashMap.newKeySet();
    private final FaultInjectingSftpAccessor sftpAccessor = new FaultInjectingSftpAccessor();
    private final EventLog<String> execRequests = new EventLog<>();
    private final EventLog<String> startedCommands = new EventLog<>();
    private final EventLog<ReceivedSignal> receivedSignals = new EventLog<>();
    private final EventLog<String> destroyedCommands = new EventLog<>();
    private final EventLog<AuthAttempt> authAttempts = new EventLog<>();
    private final EventLog<SshdSocketAddress> forwardRequests = new EventLog<>();
    private final EventLog<String> acceptedConnections = new EventLog<>();
    private volatile boolean swallowKeepAlives;
    private volatile boolean refuseChannels;

    private EmbeddedSshServer(Builder builder) {
        this.hostKey = builder.hostKey != null ? builder.hostKey : newKeyPair();
        this.sftpRoot = builder.sftpRoot;
        this.executor.setDaemon(true);
        this.scripts.putAll(builder.scripts);

        Map<String, String> passwords = Map.copyOf(builder.passwords);
        Map<String, List<PublicKey>> publicKeys = Map.copyOf(builder.publicKeys);
        boolean forwarding = builder.allowTcpForwarding;

        server = SshServer.setUpDefaultServer();
        server.setHost(HOST);
        server.setPort(builder.port);
        server.setKeyPairProvider(KeyPairProvider.wrap(hostKey));
        server.setPasswordAuthenticator((user, password, session) -> {
            boolean accepted = password != null && password.equals(passwords.get(user));
            authAttempts.add(new AuthAttempt(user, "password", accepted));
            return accepted;
        });
        server.setPublickeyAuthenticator((user, key, session) -> {
            boolean accepted = publicKeys.getOrDefault(user, List.of()).stream().anyMatch(known -> KeyUtils.compareKeys(known, key));
            authAttempts.add(new AuthAttempt(user, "publickey", accepted));
            return accepted;
        });
        server.setCommandFactory((channel, command) -> {
            execRequests.add(command);
            ScriptedCommand script = scripts.getOrDefault(command, ScriptedCommand.exits(127, "", "unknown command: " + command + "\n"));
            if (script instanceof ScriptedCommand.Refused) {
                return null; // MINA answers SSH_MSG_CHANNEL_FAILURE to an exec request that wanted a reply
            }
            if (script instanceof ScriptedCommand.DropsConnection) {
                channel.getSession().close(true); // before MINA writes its reply: the client gets no answer
                return null;
            }
            return new ScriptedCommandSession(command, script, executor, startedCommands, receivedSignals, destroyedCommands);
        });
        server.addSessionListener(new SessionListener() {
            @Override
            public void sessionEstablished(Session session) {
                acceptedConnections.add(String.valueOf(session.getRemoteAddress()));
            }

            @Override
            public void sessionEvent(Session session, SessionListener.Event event) {
                if (event == SessionListener.Event.Authenticated && refuseChannels) {
                    allowChannels(session, false);
                }
            }
        });
        server.addChannelListener(new ChannelListener() {
            @Override
            public void channelOpenSuccess(Channel channel) {
                openChannels.add(channel);
            }

            @Override
            public void channelClosed(Channel channel, Throwable reason) {
                openChannels.remove(channel);
            }
        });
        server.setForwardingFilter(ForwardingFilter.asForwardingFilter(AgentForwardingFilter.of(false), X11ForwardingFilter.of(false), new TcpForwardingFilter() {
            @Override
            public boolean canListen(SshdSocketAddress address, Session session) {
                return false;
            }

            @Override
            public boolean canConnect(TcpForwardingFilter.Type type, SshdSocketAddress address, Session session) {
                forwardRequests.add(address);
                return forwarding;
            }
        }));
        List<RequestHandler<ConnectionService>> globalHandlers = new ArrayList<>();
        globalHandlers.add((service, request, wantReply, buffer) -> swallowKeepAlives && request.startsWith("keepalive@")
            ? RequestHandler.Result.Replied // handled, and no reply is sent: the peer sees a silent server
            : RequestHandler.Result.Unsupported); // the next handler decides
        globalHandlers.addAll(ServerBuilder.DEFAULT_GLOBAL_REQUEST_HANDLERS);
        server.setGlobalRequestHandlers(globalHandlers);

        if (sftpRoot != null) {
            server.setFileSystemFactory(new VirtualFileSystemFactory(sftpRoot));
            server.setSubsystemFactories(List.of(new SftpSubsystemFactory.Builder().withFileSystemAccessor(sftpAccessor).build()));
            if (!builder.posixRenameAdvertised) {
                String advertised = AbstractSftpSubsystemHelper.DEFAULT_OPEN_SSH_EXTENSIONS.stream()
                    .filter(extension -> !PosixRenameExtensionParser.NAME.equals(extension.getName()))
                    .map(extension -> extension.getName() + "=" + extension.getVersion())
                    .collect(Collectors.joining(","));
                SftpModuleProperties.OPENSSH_EXTENSIONS.set(server, advertised);
            }
        }
        builder.customizers.forEach(customizer -> customizer.accept(server));
    }

    /** A new builder: no user can log in, no command is scripted, no SFTP, no forwarding, a fresh host key, a free port. */
    public static Builder builder() {
        return new Builder();
    }

    /** A new EC P-256 key pair: a host key or a client identity for the tests (what {@code SshSpikeTest} used). */
    public static KeyPair newKeyPair() {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
            generator.initialize(256);
            return generator.generateKeyPair();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("the JDK has no EC key generator", e);
        }
    }

    /** A new Ed25519 key pair made by MINA (it needs the EdDSA provider of the module's runtime class path, see build.gradle.kts). */
    public static KeyPair newEd25519KeyPair() {
        try {
            return KeyUtils.generateKeyPair(KeyPairProvider.SSH_ED25519, 256);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("MINA cannot make an Ed25519 key: is there an EdDSA provider?", e);
        }
    }

    /** The address clients connect to: {@link #HOST}. */
    public String host() {
        return HOST;
    }

    /** The port the server listens on (the real one, also when the builder asked for a free port). */
    public int port() {
        return server.getPort();
    }

    /** The host key pair the server presents. */
    public KeyPair hostKey() {
        return hostKey;
    }

    /** The public half of the host key: what a pinning verifier compares with. */
    public PublicKey hostPublicKey() {
        return hostKey.getPublic();
    }

    /** The {@code SHA256:...} fingerprint of the host key, as MINA prints it. */
    public String hostKeyFingerprint() {
        return KeyUtils.getFingerPrint(hostKey.getPublic());
    }

    /** The SFTP root directory, when the server has an SFTP subsystem. */
    public Optional<Path> sftpRoot() {
        return Optional.ofNullable(sftpRoot);
    }

    /** Every exec request that reached the server, in arrival order, refused ones included. This is the count for "no automatic resend" checks. */
    public EventLog<String> execRequests() {
        return execRequests;
    }

    /** The number of exec requests that reached the server so far. */
    public int execRequestCount() {
        return execRequests.size();
    }

    /** The commands whose {@code start} ran (an accepted exec the server began to play), in order. A refused exec never appears here. */
    public EventLog<String> startedCommands() {
        return startedCommands;
    }

    /** The {@code signal} requests delivered to a started command through its {@code Environment} signal listener. */
    public EventLog<ReceivedSignal> receivedSignals() {
        return receivedSignals;
    }

    /** The commands whose {@code destroy} ran: the channel of a command ended, by the command or by the client closing it. */
    public EventLog<String> destroyedCommands() {
        return destroyedCommands;
    }

    /** The authentication checks the server made, in order. A public-key login adds two entries (the key offer, then the signed request). */
    public EventLog<AuthAttempt> authAttempts() {
        return authAttempts;
    }

    /** The target of every direct-tcpip channel a client asked this server to open (allowed or not). */
    public EventLog<SshdSocketAddress> forwardRequests() {
        return forwardRequests;
    }

    /** One entry (the client's address) for every TCP connection the server accepted, in order: the count is the number of connections a client made. */
    public EventLog<String> acceptedConnections() {
        return acceptedConnections;
    }

    /** The number of SSH sessions that are open on the server right now (authenticated or not). */
    public int activeSessionCount() {
        return server.getActiveSessions().size();
    }

    /** Adds or replaces the script of a command text while the server runs. */
    public void script(String commandText, ScriptedCommand script) {
        scripts.put(commandText, script);
    }

    /** While true, the server does not answer a {@code keepalive@...} global request (it neither succeeds nor fails it): the peer's probe times out. */
    public void swallowKeepAlives(boolean swallow) {
        this.swallowKeepAlives = swallow;
    }

    /**
     * While true, every new channel a client asks for is refused with {@code SSH_MSG_CHANNEL_OPEN_FAILURE} ("additional sessions disabled", reason connect-failed), on the
     * sessions that exist now and on every session that logs in later; the channels that are open keep running. It is what a server at its {@code MaxSessions} does.
     */
    public void refuseNewChannels(boolean refuse) {
        this.refuseChannels = refuse;
        for (AbstractSession session : server.getActiveSessions()) {
            allowChannels(session, !refuse);
        }
    }

    private void allowChannels(Session session, boolean allow) {
        try {
            session.getService(ConnectionService.class).setAllowMoreSessions(allow);
        } catch (RuntimeException e) {
            // The session has not logged in yet (it has no connection service); the listener applies the switch when it does.
        }
    }

    /** Arms an SFTP failure; it stays armed until it has fired {@link SftpFault#times()} times or {@link #clearSftpFaults()}. */
    public void injectSftpFault(SftpFault fault) {
        sftpAccessor.add(fault);
    }

    /** Disarms every SFTP failure. */
    public void clearSftpFaults() {
        sftpAccessor.clear();
    }

    /**
     * Ends every session that has no open channel with a disconnect message (the server's idle clean-up): a client that holds such a session is left with a dead one.
     *
     * @return how many sessions were disconnected
     */
    public int disconnectIdleSessions() throws IOException {
        int count = 0;
        for (AbstractSession session : server.getActiveSessions()) {
            if (openChannels.stream().noneMatch(channel -> channel.getSession() == session)) {
                session.disconnect(SshConstants.SSH2_DISCONNECT_BY_APPLICATION, "idle session closed by the test server");
                count++;
            }
        }
        return count;
    }

    /**
     * Cuts every connection at once, without a disconnect message (a link failure or a killed server): waits until the sessions are closed on the server side.
     *
     * @return how many sessions were closed
     */
    public int dropConnections() throws IOException {
        List<AbstractSession> sessions = server.getActiveSessions();
        for (AbstractSession session : sessions) {
            session.close(true).await(DROP_LIMIT);
        }
        return sessions.size();
    }

    /** Stops the server and closes every session. */
    @Override
    public void close() throws IOException {
        server.stop(true);
    }

    /** Collects the settings; {@link #start()} makes the server. */
    public static final class Builder {
        private int port;
        private KeyPair hostKey;
        private Path sftpRoot;
        private boolean posixRenameAdvertised = true;
        private boolean allowTcpForwarding;
        private final Map<String, String> passwords = new HashMap<>();
        private final Map<String, List<PublicKey>> publicKeys = new HashMap<>();
        private final Map<String, ScriptedCommand> scripts = new LinkedHashMap<>();
        private final List<Consumer<SshServer>> customizers = new ArrayList<>();

        private Builder() {
        }

        /** The port to listen on; 0 (the default) is a free port. Used to bring a server back at the address of one that was closed. */
        public Builder port(int port) {
            this.port = port;
            return this;
        }

        /** The host key to present; a fresh EC key by default. */
        public Builder hostKey(KeyPair hostKey) {
            this.hostKey = hostKey;
            return this;
        }

        /** Lets {@code user} log in with {@code password}. */
        public Builder password(String user, String password) {
            passwords.put(user, password);
            return this;
        }

        /** Lets {@code user} log in with the key whose public half is given; may be called more than once per user. */
        public Builder publicKey(String user, PublicKey key) {
            publicKeys.computeIfAbsent(user, name -> new ArrayList<>()).add(key);
            return this;
        }

        /** Scripts an exec command by its exact text. An unscripted command exits with 127 and an "unknown command" message on stderr. */
        public Builder script(String commandText, ScriptedCommand script) {
            scripts.put(commandText, script);
            return this;
        }

        /** Adds an SFTP subsystem whose file system is {@code root} (a test's temporary directory). */
        public Builder sftp(Path root) {
            this.sftpRoot = root;
            return this;
        }

        /** Whether the SFTP server advertises {@code posix-rename@openssh.com}; true by default, as MINA 2.20.1 does. Needs {@link #sftp(Path)}. */
        public Builder sftpAdvertisesPosixRename(boolean advertised) {
            this.posixRenameAdvertised = advertised;
            return this;
        }

        /** Lets clients open direct-tcpip channels (a jump host); the default refuses them. Every request is recorded either way. */
        public Builder allowTcpForwarding() {
            this.allowTcpForwarding = true;
            return this;
        }

        /** An escape hatch for what this tool does not offer: the consumer gets the MINA server before it starts (cipher lists, session properties ...). */
        public Builder customize(Consumer<SshServer> customizer) {
            customizers.add(customizer);
            return this;
        }

        /** Starts the server and returns it. */
        public EmbeddedSshServer start() throws IOException {
            EmbeddedSshServer created = new EmbeddedSshServer(this);
            created.server.start();
            return created;
        }
    }
}
