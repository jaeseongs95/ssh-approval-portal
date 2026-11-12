package io.github.jaeseongs95.portal.ssh.session;

import io.github.jaeseongs95.portal.app.remote.CancelToken;
import io.github.jaeseongs95.portal.app.remote.SshSettings;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TtyMode;
import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ScheduledFuture;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.common.SshConstants;
import org.apache.sshd.common.session.Session;
import org.apache.sshd.common.session.SessionListener;
import org.apache.sshd.common.util.buffer.Buffer;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.core.task.TaskExecutor;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.stereotype.Component;

/**
 * The live SSH sessions, one per connection profile (stage 3 design 3.5, defect D-0038), and the one place a session is made.
 *
 * <ul>
 * <li><b>One connection per profile at a time.</b> The slot of a profile holds one future; callers that arrive while the connection is being made share it. A failed
 * connection empties the slot before its waiters are woken, so the failure is the answer of those callers only and is never replayed to a later one (vendor defect #197).</li>
 * <li><b>A dead session is found before a command is sent.</b> A session that is closed is dropped. A session that nothing used for {@code idleProbeAfter} is probed with the
 * global request {@code keepalive@openssh.com} (pilot P3-2: any answer, FAILURE included, proves it alive; a timeout or an I/O error proves it dead, and a session whose probe
 * timed out is never probed again, because MINA matches replies in order). A dead session is closed, and a new connection is made <em>once</em>.</li>
 * <li><b>Nothing is reconnected after a command was sent.</b> This class is asked for a session before the request, never after: a session that dies while a command runs is
 * the executor's {@code transportLost}, and the next request gets a new session.</li>
 * <li><b>Channels.</b> A session allows {@code channelPermits} channels at once (below the 10 sessions an OpenSSH server allows by default); a full session answers
 * {@link AcquireResult.NoChannelPermit} without waiting. A channel-open refusal does not kill the session; {@code consecutiveOpenRejections} refusals in a row and no channel in
 * use close it (decision D3-08). There is no retry of a refused open.</li>
 * </ul>
 *
 * <p>Making a connection runs on the injected executor (it blocks for the connection timeout); a caller waits for it together with its {@link CancelToken}.
 */
@Component
public final class SshSessionPool implements InitializingBean, DisposableBean {

    /** How long a probe waits for the reply: short, because the session was idle and its answer is one round trip. */
    static final Duration PROBE_TIMEOUT = Duration.ofSeconds(5);
    private static final String PROBE_REQUEST = "keepalive@openssh.com";

    /** A slot's content: a live session, or the diagnosis of the connection that failed. */
    private sealed interface SlotValue permits SlotValue.Live, SlotValue.Down {
        record Live(PooledSession session) implements SlotValue {
        }

        record Down(ConnectFailure failure) implements SlotValue {
        }
    }

    /** What one pass over a slot found: an answer for the caller, or a session that turned out dead (the caller may reconnect once). */
    private sealed interface Pick permits Pick.Ready, Pick.Stale {
        record Ready(AcquireResult result) implements Pick {
        }

        record Stale() implements Pick {
        }
    }

    private final SshSettings settings;
    private final SessionConnector connector;
    private final Clock clock;
    private final TaskExecutor executor;
    private final TaskScheduler scheduler;
    private final SessionReapSettings reap;
    private final ConcurrentHashMap<ProfileAlias, CompletableFuture<SlotValue>> slots = new ConcurrentHashMap<>();
    private volatile ScheduledFuture<?> sweep;

    public SshSessionPool(SshSettings settings, SessionConnector connector, Clock clock, TaskExecutor executor, TaskScheduler scheduler, SessionReapSettings reap) {
        this.settings = settings;
        this.connector = connector;
        this.clock = clock;
        this.executor = executor;
        this.scheduler = scheduler;
        this.reap = reap;
    }

    /** Starts the sweep that closes idle sessions (VR-416, VR-419: a session with no channel in use that rested for {@code idleAfter}). */
    @Override
    public void afterPropertiesSet() {
        sweep = scheduler.scheduleWithFixedDelay(this::closeIdleSessions, clock.instant().plus(reap.sweepEvery()), reap.sweepEvery());
    }

    /** One sweep: a live session nobody leases and nobody used for {@code idleAfter} leaves the pool and is closed; a session with a channel in use is left alone. */
    void closeIdleSessions() {
        for (CompletableFuture<SlotValue> slot : slots.values()) {
            if (slot.isDone() && slot.join() instanceof SlotValue.Live live && live.session().restedFor(reap.idleAfter())) {
                live.session().unfit();
            }
        }
    }

    /**
     * A session for the profile and one channel permit on it. Blocks while a connection is made or a probe waits; returns {@link AcquireResult.Cancelled} as soon as the
     * owner's cancel is requested. Sends nothing to the target.
     */
    public AcquireResult acquire(ProfileAlias alias, CancelToken cancel) {
        Pick first = pick(alias, cancel);
        if (first instanceof Pick.Ready ready) {
            return ready.result();
        }
        // The session was dead. The one reconnect of design 3.5, item 2: a second pass makes (or joins) a new connection; a second dead session is a failed connection.
        Pick second = pick(alias, cancel);
        if (second instanceof Pick.Ready ready) {
            return ready.result();
        }
        return new AcquireResult.Failed(new ConnectFailure(ConnectFailureCause.UNREACHABLE, alias));
    }

    private Pick pick(ProfileAlias alias, CancelToken cancel) {
        CompletableFuture<SlotValue> mine = new CompletableFuture<>();
        CompletableFuture<SlotValue> slot = slots.putIfAbsent(alias, mine);
        if (slot == null) {
            slot = mine;
            startConnecting(alias, mine);
        }
        try {
            CompletableFuture.anyOf(slot, cancel.whenRequested().toCompletableFuture()).get();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new Pick.Ready(new AcquireResult.Cancelled());
        } catch (ExecutionException e) {
            return new Pick.Ready(new AcquireResult.Failed(new ConnectFailure(ConnectFailureCause.UNREACHABLE, alias)));
        }
        if (cancel.requested()) {
            return new Pick.Ready(new AcquireResult.Cancelled());
        }
        SlotValue value = slot.join();
        if (value instanceof SlotValue.Down down) {
            return new Pick.Ready(new AcquireResult.Failed(down.failure()));
        }
        PooledSession pooled = ((SlotValue.Live) value).session();
        if (!pooled.isOpen()) {
            pooled.unfit();
            return new Pick.Stale();
        }
        if (pooled.restedFor(settings.idleProbeAfter()) && !isAlive(pooled)) {
            pooled.unfit();
            return new Pick.Stale();
        }
        if (!pooled.tryAcquirePermit()) {
            return new Pick.Ready(new AcquireResult.NoChannelPermit());
        }
        if (pooled.retired()) {
            // Left the pool between the check and the permit (a lost transport reported by another thread): the permit is of no use.
            pooled.release();
            return new Pick.Stale();
        }
        return new Pick.Ready(new AcquireResult.Leased(new ChannelLease(pooled)));
    }

    /** Makes the connection on the executor and fills the slot; a failure empties the slot first. */
    private void startConnecting(ProfileAlias alias, CompletableFuture<SlotValue> slot) {
        try {
            executor.execute(() -> slot.complete(connectInto(alias, slot)));
        } catch (RuntimeException e) {
            slots.remove(alias, slot);
            slot.complete(new SlotValue.Down(new ConnectFailure(ConnectFailureCause.UNREACHABLE, alias)));
        }
    }

    private SlotValue connectInto(ProfileAlias alias, CompletableFuture<SlotValue> slot) {
        ConnectOutcome outcome;
        try {
            outcome = connector.connect(alias);
        } catch (RuntimeException e) {
            outcome = new ConnectOutcome.Failed(new ConnectFailure(ConnectFailureCause.UNREACHABLE, alias));
        }
        if (!(outcome instanceof ConnectOutcome.Connected connected)) {
            slots.remove(alias, slot);
            return new SlotValue.Down(((ConnectOutcome.Failed) outcome).failure());
        }
        boolean tty = connected.hops().get(connected.hops().size() - 1).profile().tty() == TtyMode.TTY;
        PooledSession pooled = new PooledSession(connected.session(), connected.client(), tty, settings.channelPermits(), settings.consecutiveOpenRejections(), clock,
            retiring -> discard(alias, slot, retiring));
        connected.session().addSessionListener(new SessionListener() {
            @Override
            public void sessionClosed(Session session) {
                pooled.lost();
            }
        });
        if (!connected.session().isOpen()) {
            pooled.lost();
        }
        return new SlotValue.Live(pooled);
    }

    /** A session leaves the pool: its slot is emptied (if it still holds this session) and its client is stopped off the calling thread. */
    private void discard(ProfileAlias alias, CompletableFuture<SlotValue> slot, PooledSession pooled) {
        slots.remove(alias, slot);
        try {
            executor.execute(pooled::stop);
        } catch (RuntimeException e) {
            pooled.stop();
        }
    }

    /** The probe of pilot P3-2: a global request that wants a reply. Any reply is alive; an I/O error or a timeout is dead. */
    private boolean isAlive(PooledSession pooled) {
        ClientSession session = pooled.session();
        try {
            Buffer request = session.createBuffer(SshConstants.SSH_MSG_GLOBAL_REQUEST);
            request.putString(PROBE_REQUEST);
            request.putBoolean(true);
            session.request(PROBE_REQUEST, request, PROBE_TIMEOUT);
            return true;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    /** Closes every live session when the application context closes. */
    @Override
    public void destroy() {
        ScheduledFuture<?> running = sweep;
        if (running != null) {
            running.cancel(false);
        }
        for (CompletableFuture<SlotValue> slot : slots.values()) {
            if (slot.isDone() && slot.join() instanceof SlotValue.Live live) {
                live.session().stop();
            }
        }
        slots.clear();
    }
}
