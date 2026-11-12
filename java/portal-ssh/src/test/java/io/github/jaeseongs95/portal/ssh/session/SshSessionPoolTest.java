package io.github.jaeseongs95.portal.ssh.session;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.app.remote.ExecReply;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionLimits;
import io.github.jaeseongs95.portal.app.remote.ExecutionPhase;
import io.github.jaeseongs95.portal.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.app.remote.PhaseMark;
import io.github.jaeseongs95.portal.app.remote.SshSettings;
import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchRefusedException;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.error.ExecutionStage;
import io.github.jaeseongs95.portal.domain.error.RemoteOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import io.github.jaeseongs95.portal.domain.operation.ExitStatus;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.RemoteState;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.ssh.testkit.AdapterFixture;
import io.github.jaeseongs95.portal.ssh.testkit.CollectingSink;
import io.github.jaeseongs95.portal.ssh.testkit.EmbeddedSshServer;
import io.github.jaeseongs95.portal.ssh.testkit.ScriptedCommand;
import java.io.IOException;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.EnumSet;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.stream.IntStream;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.client.session.ClientSession.ClientSessionEvent;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.util.unit.DataSize;
import io.github.jaeseongs95.portal.app.remote.HostKeyMode;

/**
 * Cases S3-SS-01 .. S3-SS-11 of docs/migration/stage3-design.md (8.5, 3.5 and 3.6, defect D-0038): the session pool, the connector, the jump chain and the host key pins
 * of the adapter, with the real MINA client against the MINA test server. The tests that need to know whether the executor sent anything count the exec requests the
 * server received.
 */
@Timeout(120)
class SshSessionPoolTest {

    private static final String USER = "tester";
    private static final String PASSWORD = "secret";
    private static final String ALIAS = "main";
    private static final Duration WAIT = Duration.ofSeconds(30);
    private static final Path UNUSED_KNOWN_HOSTS = Path.of("known-hosts-not-used-by-the-tests");

    private EmbeddedSshServer server;
    private EmbeddedSshServer jump;
    private AdapterFixture adapter;

    @AfterEach
    void stop() throws IOException {
        if (adapter != null) {
            adapter.close();
        }
        if (jump != null) {
            jump.close();
        }
        if (server != null) {
            server.close();
        }
    }

    private EmbeddedSshServer.Builder serverBuilder() {
        return EmbeddedSshServer.builder().password(USER, PASSWORD).script("echo ok", ScriptedCommand.exits(0, "ok\n", "")).script("hang", ScriptedCommand.hangs());
    }

    private void startAll(SshSettings settings) throws IOException {
        server = serverBuilder().start();
        adapter = AdapterFixture.start(settings);
        adapter.profiles().put(ALIAS, AdapterFixture.profileFor(server, USER));
        adapter.credentials().password(ALIAS, PASSWORD);
    }

    private static SshSettings settings(Duration heartbeat, Duration idleProbe, int permits) {
        return new SshSettings(Duration.ofSeconds(10), heartbeat, SshSettings.DEFAULT_HEARTBEAT_NO_REPLY_MAX, idleProbe, SshSettings.DEFAULT_EXEC_REPLY_TIMEOUT, permits,
            SshSettings.DEFAULT_CONSECUTIVE_OPEN_REJECTIONS, HostKeyMode.TOFU, UNUSED_KNOWN_HOSTS);
    }

    private static ExecutionLimits limits(long deadlineMillis, long graceMillis) {
        return new ExecutionLimits(Duration.ofMillis(deadlineMillis), Duration.ofMillis(graceMillis), DataSize.ofMegabytes(1));
    }

    private ExecutionReport run(String alias, String command) {
        return adapter.executor().run(AdapterFixture.execution(alias, command, ExecutionLimits.defaults(), ExecReply.NOT_AWAITED), CollectingSink.accepting(),
            AdapterFixture.control());
    }

    private ExecutionReport run(String command) {
        return run(ALIAS, command);
    }

    private ChannelLease lease(String alias) {
        AcquireResult result = adapter.pool().acquire(new ProfileAlias(alias), new CancelSource());
        assertThat(result).isInstanceOf(AcquireResult.Leased.class);
        return ((AcquireResult.Leased) result).lease();
    }

    private static ExecutionFailure.Classified classified(ExecutionOutcome outcome) {
        assertThat(outcome.failure()).isInstanceOf(ExecutionFailure.Classified.class);
        return (ExecutionFailure.Classified) outcome.failure();
    }

    @Test
    @DisplayName("S3-SS-01 a session the server closed while it was idle: the next request makes a new connection, runs exactly once and succeeds")
    void aSessionClosedByTheServer() throws Exception {
        startAll(AdapterFixture.defaultSettings());
        assertThat(run("echo ok").outcome().verdict()).isEqualTo(OperationState.COMPLETED);
        ClientSession session;
        try (ChannelLease lease = lease(ALIAS)) {
            session = lease.session();
        }
        assertThat(server.dropConnections()).isEqualTo(1);
        assertThat(session.waitFor(EnumSet.of(ClientSessionEvent.CLOSED), WAIT)).contains(ClientSessionEvent.CLOSED);
        ExecutionOutcome outcome = run("echo ok").outcome();
        assertThat(outcome.verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(server.acceptedConnections().size()).isEqualTo(2);
        assertThat(server.execRequests().snapshot()).as("each request ran once").containsExactly("echo ok", "echo ok");
    }

    @Test
    @DisplayName("S3-SS-01 a session that is dead but not yet noticed (the server answers nothing): the probe before the request finds it, one new connection is made, the command runs once")
    void aSilentDeadSessionIsFoundByTheProbe() throws Exception {
        startAll(AdapterFixture.defaultSettings());
        assertThat(run("echo ok").outcome().verdict()).isEqualTo(OperationState.COMPLETED);
        // The session has rested for longer than idleProbeAfter (10 s): the clock of the pool is moved forward, no waiting. The earlier version of this case set the idle time
        // to 1 ms and the second request came less than 1 ms after the first one, so the session was not idle yet and was not probed.
        adapter.clock().advance(SshSettings.DEFAULT_IDLE_PROBE_AFTER.plusSeconds(1));
        server.swallowKeepAlives(true);
        ExecutionOutcome outcome = run("echo ok").outcome();
        assertThat(outcome.verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(server.acceptedConnections().size()).as("the probe timed out and a second connection was made").isEqualTo(2);
        assertThat(server.execRequests().snapshot()).containsExactly("echo ok", "echo ok");
    }

    @Test
    @DisplayName("S3-SS-02 / vendor defect 197 the first connection fails (closed port), the next request after the server started succeeds: a failed connection is not replayed")
    void aFailedConnectionIsNotReplayed() throws Exception {
        EmbeddedSshServer probe = serverBuilder().start();
        int port = probe.port();
        probe.close();
        adapter = AdapterFixture.start(AdapterFixture.defaultSettings());
        adapter.credentials().password(ALIAS, PASSWORD);
        adapter.profiles().put(ALIAS, new io.github.jaeseongs95.portal.domain.target.ConnectionProfile("127.0.0.1", port, USER,
            io.github.jaeseongs95.portal.domain.target.Setting.unset(), io.github.jaeseongs95.portal.domain.target.Setting.unset(),
            io.github.jaeseongs95.portal.domain.target.AuthMethod.PASSWORD, io.github.jaeseongs95.portal.domain.target.Setting.unset(),
            io.github.jaeseongs95.portal.domain.target.Setting.unset(), io.github.jaeseongs95.portal.domain.target.AccessMode.READ_WRITE,
            io.github.jaeseongs95.portal.domain.target.TtyMode.NO_TTY));
        ExecutionOutcome first = run("echo ok").outcome();
        assertThat(classified(first).stage()).isEqualTo(ExecutionStage.SSH_CONNECT);
        assertThat(classified(first).code()).isEqualTo(ExecutionErrorCode.SSH_CONNECT_FAILED);
        server = serverBuilder().port(port).start();
        ExecutionOutcome second = run("echo ok").outcome();
        assertThat(second.verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(server.execRequests().snapshot()).containsExactly("echo ok");
    }

    @Test
    @DisplayName("S3-SS-03 / D-0038 the three failures are three values: no connection is SSH_CONNECT_FAILED, no channel permit is SSH_CHANNEL_OPEN_FAILED without touching the server, a lost transport is UNKNOWN")
    void threeDifferentFailures() throws Exception {
        startAll(settings(SshSettings.DEFAULT_HEARTBEAT_INTERVAL, SshSettings.DEFAULT_IDLE_PROBE_AFTER, 1));
        EmbeddedSshServer closed = serverBuilder().start();
        int closedPort = closed.port();
        closed.close();
        adapter.profiles().put("closed", new io.github.jaeseongs95.portal.domain.target.ConnectionProfile("127.0.0.1", closedPort, USER,
            io.github.jaeseongs95.portal.domain.target.Setting.unset(), io.github.jaeseongs95.portal.domain.target.Setting.unset(),
            io.github.jaeseongs95.portal.domain.target.AuthMethod.PASSWORD, io.github.jaeseongs95.portal.domain.target.Setting.unset(),
            io.github.jaeseongs95.portal.domain.target.Setting.unset(), io.github.jaeseongs95.portal.domain.target.AccessMode.READ_WRITE,
            io.github.jaeseongs95.portal.domain.target.TtyMode.NO_TTY));
        adapter.credentials().password("closed", PASSWORD);
        ExecutionOutcome noConnection = run("closed", "echo ok").outcome();

        CancelSource cancelHang = new CancelSource();
        CompletableFuture<ExecutionReport> hanging = CompletableFuture.supplyAsync(
            () -> adapter.executor().run(AdapterFixture.execution(ALIAS, "hang", limits(60_000, 300), ExecReply.NOT_AWAITED), CollectingSink.accepting(),
                AdapterFixture.control(cancelHang)), adapter.async());
        server.startedCommands().await(1, WAIT);
        ExecutionOutcome noPermit = run("echo ok").outcome();
        assertThat(server.execRequests().snapshot()).as("the full session was not asked for another channel").containsExactly("hang");
        assertThat(server.acceptedConnections().size()).isEqualTo(1);

        assertThat(server.dropConnections()).isEqualTo(1);
        ExecutionOutcome lost = hanging.get(WAIT.toSeconds(), TimeUnit.SECONDS).outcome();

        assertThat(noConnection.remoteState()).isEqualTo(RemoteState.NOT_DISPATCHED);
        assertThat(classified(noConnection).stage()).isEqualTo(ExecutionStage.SSH_CONNECT);
        assertThat(classified(noConnection).code()).isEqualTo(ExecutionErrorCode.SSH_CONNECT_FAILED);
        assertThat(noPermit.remoteState()).isEqualTo(RemoteState.NOT_DISPATCHED);
        assertThat(classified(noPermit).code()).isEqualTo(ExecutionErrorCode.SSH_CHANNEL_OPEN_FAILED);
        assertThat(lost.remoteState()).isEqualTo(RemoteState.UNKNOWN);
        assertThat(lost.reason()).isEqualTo(ExecutionReason.TRANSPORT_LOST);
        assertThat(classified(lost).remoteOutcome()).isEqualTo(RemoteOutcome.UNKNOWN);
        assertThat(List.of(classified(noConnection).code(), classified(noPermit).code(), classified(lost).code())).doesNotHaveDuplicates();
    }

    @Test
    @DisplayName("S3-SS-04 a refused channel open does not kill the session: the next lease is the same MINA session, and the server accepted one connection")
    void aRefusedOpenKeepsTheSameSession() throws Exception {
        startAll(AdapterFixture.defaultSettings());
        ClientSession before;
        try (ChannelLease lease = lease(ALIAS)) {
            before = lease.session();
        }
        server.refuseNewChannels(true);
        assertThat(run("echo ok").outcome().reason()).isEqualTo(ExecutionReason.CHANNEL_OPEN_FAILED);
        server.refuseNewChannels(false);
        try (ChannelLease lease = lease(ALIAS)) {
            assertThat(lease.session()).isSameAs(before);
        }
        assertThat(server.acceptedConnections().size()).isEqualTo(1);
    }

    @Test
    @DisplayName("S3-SS-04 / D3-08 three refused opens in a row close a session that has no channel in use; the request after that gets a new connection")
    void threeRefusalsInARowCloseTheSession() throws Exception {
        startAll(AdapterFixture.defaultSettings());
        ClientSession before;
        try (ChannelLease lease = lease(ALIAS)) {
            before = lease.session();
        }
        server.refuseNewChannels(true);
        for (int i = 0; i < SshSettings.DEFAULT_CONSECUTIVE_OPEN_REJECTIONS; i++) {
            assertThat(run("echo ok").outcome().reason()).isEqualTo(ExecutionReason.CHANNEL_OPEN_FAILED);
        }
        assertThat(before.waitFor(EnumSet.of(ClientSessionEvent.CLOSED), WAIT)).contains(ClientSessionEvent.CLOSED);
        server.refuseNewChannels(false);
        assertThat(run("echo ok").outcome().verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(server.acceptedConnections().size()).isEqualTo(2);
    }

    @Test
    @DisplayName("S3-SS-05 the timeline of a failed connection has CONNECT_STARTED and nothing after it, no REQUEST_SENT")
    void theTimelineOfAFailedConnection() throws Exception {
        startAll(AdapterFixture.defaultSettings());
        adapter.credentials().password(ALIAS, "wrong-secret");
        ExecutionReport report = run("echo ok");
        assertThat(report.timeline().marks()).extracting(PhaseMark::phase).containsExactly(ExecutionPhase.CONNECT_STARTED);
        assertThat(report.timeline().at(ExecutionPhase.REQUEST_SENT)).isEmpty();
    }

    @Test
    @DisplayName("S3-SS-06 heartbeat: a server that stops answering is found within interval x count, the session closes and the slot is emptied (the next request connects again)")
    void heartbeat() throws Exception {
        startAll(settings(Duration.ofMillis(200), SshSettings.DEFAULT_IDLE_PROBE_AFTER, SshSettings.DEFAULT_CHANNEL_PERMITS));
        ClientSession session;
        try (ChannelLease lease = lease(ALIAS)) {
            session = lease.session();
        }
        server.swallowKeepAlives(true);
        Clock clock = Clock.systemUTC();
        Instant started = clock.instant();
        assertThat(session.waitFor(EnumSet.of(ClientSessionEvent.CLOSED), Duration.ofSeconds(20))).contains(ClientSessionEvent.CLOSED);
        Duration detection = Duration.between(started, clock.instant());
        assertThat(detection).as("heartbeat every 200 ms, three unanswered").isLessThan(Duration.ofSeconds(10));
        server.swallowKeepAlives(false);
        assertThat(run("echo ok").outcome().verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(server.acceptedConnections().size()).isEqualTo(2);
    }

    @Test
    @DisplayName("S3-SS-07 host keys per hop: a pinned fingerprint is accepted, another one is refused before any login and nothing runs (the modes tofu, strict and insecure and the known_hosts file are the tests of ServerKeyPolicy)")
    void hostKeyPins() throws Exception {
        startAll(AdapterFixture.defaultSettings());
        adapter.profiles().put("pinned", AdapterFixture.profileWithPin(server, USER, server.hostKeyFingerprint()));
        adapter.credentials().password("pinned", PASSWORD);
        assertThat(run("pinned", "echo ok").outcome().verdict()).isEqualTo(OperationState.COMPLETED);

        adapter.profiles().put("wrongpin", AdapterFixture.profileWithPin(server, USER, "SHA256:" + "A".repeat(43)));
        adapter.credentials().password("wrongpin", PASSWORD);
        int loginsBefore = server.authAttempts().size();
        ExecutionOutcome refused = run("wrongpin", "echo ok").outcome();
        assertThat(classified(refused).code()).isEqualTo(ExecutionErrorCode.SSH_CONNECT_FAILED);
        assertThat(server.authAttempts().size()).as("no login was tried at a host whose key was refused").isEqualTo(loginsBefore);
        assertThat(server.execRequests().snapshot()).containsExactly("echo ok");
        AcquireResult result = adapter.pool().acquire(new ProfileAlias("wrongpin"), new CancelSource());
        assertThat(result).isEqualTo(new AcquireResult.Failed(new ConnectFailure(ConnectFailureCause.HOST_KEY_REFUSED, new ProfileAlias("wrongpin"))));
    }

    @Test
    @DisplayName("S3-SS-08 ProxyJump: the target is reached through the jump host with each hop's own credential; a wrong jump credential is a failed connection that names the jump profile")
    void proxyJump() throws Exception {
        server = EmbeddedSshServer.builder().password("tgt", "target-secret").script("echo hello", ScriptedCommand.exits(0, "hello\n", "")).start();
        jump = EmbeddedSshServer.builder().password("jumper", "jump-secret").allowTcpForwarding().start();
        adapter = AdapterFixture.start(AdapterFixture.defaultSettings());
        adapter.profiles().put("jump", AdapterFixture.profileFor(jump, "jumper")).put("tgt", AdapterFixture.profileVia(server, "tgt", "jump"));
        adapter.credentials().password("jump", "jump-secret").password("tgt", "target-secret");
        CollectingSink sink = CollectingSink.accepting();
        ExecutionOutcome outcome = adapter.executor().run(AdapterFixture.execution("tgt", "echo hello", ExecutionLimits.defaults(), ExecReply.NOT_AWAITED), sink,
            AdapterFixture.control()).outcome();
        assertThat(sink.stdout()).isEqualTo("hello\n");
        assertThat(outcome.exit()).isEqualTo(new ExitStatus.Exited(0));
        assertThat(server.execRequests().snapshot()).containsExactly("echo hello");
        assertThat(jump.execRequests().snapshot()).isEmpty();
        assertThat(jump.forwardRequests().size()).isEqualTo(1);

        adapter.credentials().password("jump", "not-the-jump-secret");
        adapter.pool().destroy();
        AcquireResult failed = adapter.pool().acquire(new ProfileAlias("tgt"), new CancelSource());
        assertThat(failed).isEqualTo(new AcquireResult.Failed(new ConnectFailure(ConnectFailureCause.AUTHENTICATION_FAILED, new ProfileAlias("jump"))));
    }

    @Test
    @DisplayName("S3-SS-08 ProxyJump: a profile whose jump profile is not configured, and a loop of jump profiles, fail as connections that name the profile")
    void jumpProfilesThatCannotBeResolved() throws Exception {
        startAll(AdapterFixture.defaultSettings());
        adapter.profiles().put("lost", AdapterFixture.profileVia(server, USER, "nowhere"));
        adapter.credentials().password("lost", PASSWORD);
        assertThat(adapter.pool().acquire(new ProfileAlias("lost"), new CancelSource()))
            .isEqualTo(new AcquireResult.Failed(new ConnectFailure(ConnectFailureCause.PROFILE_NOT_CONFIGURED, new ProfileAlias("nowhere"))));
        adapter.profiles().put("a", AdapterFixture.profileVia(server, USER, "b")).put("b", AdapterFixture.profileVia(server, USER, "a"));
        adapter.credentials().password("a", PASSWORD).password("b", PASSWORD);
        assertThat(adapter.pool().acquire(new ProfileAlias("a"), new CancelSource()))
            .isEqualTo(new AcquireResult.Failed(new ConnectFailure(ConnectFailureCause.PROFILE_LOOP, new ProfileAlias("a"))));
    }

    @Test
    @DisplayName("S3-SS-09 / RC-B-462 the guard is asked after the connection and before anything is sent: a refusal throws DispatchRefusedException, the server saw no exec, and the channel permit is back")
    void theDispatchGuard() throws Exception {
        startAll(settings(SshSettings.DEFAULT_HEARTBEAT_INTERVAL, SshSettings.DEFAULT_IDLE_PROBE_AFTER, 1));
        ExecutionControl refusing = new ExecutionControl(new CancelSource(), () -> {
            throw new DispatchRefusedException(DispatchFailure.refused(DispatchReason.TARGET_CHANGED, DispatchStage.TARGET_GUARD));
        });
        assertThatThrownBy(() -> adapter.executor().run(AdapterFixture.execution(ALIAS, "echo ok", ExecutionLimits.defaults(), ExecReply.NOT_AWAITED), CollectingSink.accepting(),
            refusing)).isInstanceOf(DispatchRefusedException.class);
        assertThat(server.execRequestCount()).isZero();
        assertThat(server.acceptedConnections().size()).as("the connection was made before the guard was asked").isEqualTo(1);
        assertThat(run("echo ok").outcome().verdict()).as("the single permit was given back").isEqualTo(OperationState.COMPLETED);
    }

    @Test
    @DisplayName("S3-SS-10 a wrong password is SSH_CONNECT_FAILED naming the profile, no secret is in the outcome, and the slot is clean: the next request with the right password succeeds")
    void authenticationFailure() throws Exception {
        startAll(AdapterFixture.defaultSettings());
        adapter.credentials().password(ALIAS, "wrong-secret");
        ExecutionOutcome failed = run("echo ok").outcome();
        assertThat(classified(failed).stage()).isEqualTo(ExecutionStage.SSH_CONNECT);
        assertThat(failed.texts()).doesNotContain("wrong-secret");
        assertThat(failed.toString()).doesNotContain("wrong-secret").doesNotContain(PASSWORD);
        assertThat(adapter.pool().acquire(new ProfileAlias(ALIAS), new CancelSource()))
            .isEqualTo(new AcquireResult.Failed(new ConnectFailure(ConnectFailureCause.AUTHENTICATION_FAILED, new ProfileAlias(ALIAS))));
        adapter.credentials().password(ALIAS, PASSWORD);
        assertThat(run("echo ok").outcome().verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(server.execRequests().snapshot()).containsExactly("echo ok");
    }

    @Test
    @DisplayName("S3-SS-11 / CR-02 eight requests for the same profile at once make one connection and all succeed")
    void concurrentRequestsShareOneConnection() throws Exception {
        startAll(AdapterFixture.defaultSettings());
        CompletableFuture<Void> gate = new CompletableFuture<>();
        List<CompletableFuture<ExecutionReport>> running = IntStream.range(0, 8).mapToObj(i -> gate.thenApplyAsync(start -> run("echo ok"), adapter.async())).toList();
        gate.complete(null);
        for (CompletableFuture<ExecutionReport> one : running) {
            assertThat(one.get(WAIT.toSeconds(), TimeUnit.SECONDS).outcome().verdict()).isEqualTo(OperationState.COMPLETED);
        }
        assertThat(server.acceptedConnections().size()).as("the connection was made once").isEqualTo(1);
        assertThat(server.execRequestCount()).isEqualTo(8);
    }

    @Test
    @DisplayName("S3-SS-12 / VR-419 the sweep closes a session that nobody used for the idle time and the next request connects again; a session with a channel in use is not closed")
    void idleSessionsAreClosed() throws Exception {
        server = serverBuilder().start();
        adapter = AdapterFixture.start(AdapterFixture.defaultSettings(), new SessionReapSettings(Duration.ofMillis(300), Duration.ofMillis(100)));
        adapter.profiles().put(ALIAS, AdapterFixture.profileFor(server, USER));
        adapter.credentials().password(ALIAS, PASSWORD);
        ClientSession idle;
        try (ChannelLease lease = lease(ALIAS)) {
            idle = lease.session();
        }
        assertThat(idle.waitFor(EnumSet.of(ClientSessionEvent.CLOSED), WAIT)).as("the sweep closed the session that rested for 300 ms").contains(ClientSessionEvent.CLOSED);
        assertThat(run("echo ok").outcome().verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(server.acceptedConnections().size()).isEqualTo(2);
        try (ChannelLease held = lease(ALIAS)) {
            assertThat(held.session().waitFor(EnumSet.of(ClientSessionEvent.CLOSED), Duration.ofSeconds(2))).as("a session with a lease is not closed").contains(ClientSessionEvent.TIMEOUT)
                .doesNotContain(ClientSessionEvent.CLOSED);
        }
    }

    @Test
    @DisplayName("S3-SS-08 / VR-416 a jump host is part of its connection, not a session of the pool: it stays open while the connection that uses it is in use")
    void aJumpHostLivesWithItsConnection() throws Exception {
        server = EmbeddedSshServer.builder().password("tgt", "target-secret").script("echo hello", ScriptedCommand.exits(0, "hello\n", "")).start();
        jump = EmbeddedSshServer.builder().password("jumper", "jump-secret").allowTcpForwarding().start();
        adapter = AdapterFixture.start(AdapterFixture.defaultSettings(), new SessionReapSettings(Duration.ofMillis(300), Duration.ofMillis(100)));
        adapter.profiles().put("jump", AdapterFixture.profileFor(jump, "jumper")).put("tgt", AdapterFixture.profileVia(server, "tgt", "jump"));
        adapter.credentials().password("jump", "jump-secret").password("tgt", "target-secret");
        try (ChannelLease held = lease("tgt")) {
            assertThat(held.session().waitFor(EnumSet.of(ClientSessionEvent.CLOSED), Duration.ofSeconds(2))).contains(ClientSessionEvent.TIMEOUT).doesNotContain(ClientSessionEvent.CLOSED);
            assertThat(jump.activeSessionCount()).as("the jump session is open as long as the connection is").isEqualTo(1);
        }
    }

    @Test
    @DisplayName("S3-SS-13 an SSH agent credential is refused before anything is connected, with its own cause")
    void anAgentCredentialIsRefused() throws Exception {
        startAll(AdapterFixture.defaultSettings());
        adapter.credentials().agent(ALIAS);
        assertThat(adapter.pool().acquire(new ProfileAlias(ALIAS), new CancelSource()))
            .isEqualTo(new AcquireResult.Failed(new ConnectFailure(ConnectFailureCause.AGENT_UNSUPPORTED, new ProfileAlias(ALIAS))));
        assertThat(server.acceptedConnections().size()).as("no connection was made").isZero();
        assertThat(ConnectFailureCause.AGENT_UNSUPPORTED.ownerText()).containsIgnoringCase("agent credential is not supported");
    }

    @Test
    @DisplayName("S3-SS-11 the permits of a session are respected: with two permits the third concurrent command is refused locally, without a channel open on the server")
    void channelPermits() throws Exception {
        startAll(settings(SshSettings.DEFAULT_HEARTBEAT_INTERVAL, SshSettings.DEFAULT_IDLE_PROBE_AFTER, 2));
        CancelSource cancel = new CancelSource();
        List<CompletableFuture<ExecutionReport>> hanging = IntStream.range(0, 2).mapToObj(i -> CompletableFuture.supplyAsync(
            () -> adapter.executor().run(AdapterFixture.execution(ALIAS, "hang", limits(60_000, 300), ExecReply.NOT_AWAITED), CollectingSink.accepting(),
                AdapterFixture.control(cancel)), adapter.async())).toList();
        server.startedCommands().await(2, WAIT);
        ExecutionOutcome third = run("echo ok").outcome();
        assertThat(classified(third).code()).isEqualTo(ExecutionErrorCode.SSH_CHANNEL_OPEN_FAILED);
        assertThat(server.execRequests().snapshot()).containsExactly("hang", "hang");
        cancel.cancel();
        for (CompletableFuture<ExecutionReport> one : hanging) {
            one.get(WAIT.toSeconds(), TimeUnit.SECONDS);
        }
        assertThat(run("echo ok").outcome().verdict()).isEqualTo(OperationState.COMPLETED);
    }
}
