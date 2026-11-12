package io.github.jaeseongs95.portal.ssh.session;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import org.apache.sshd.client.SshClient;
import org.apache.sshd.client.session.ClientSession;

/**
 * An authenticated session of the pool with the state the pool decides by: the channel permits, the leases in use, the run of channel-open refusals and the time it was
 * last used. The pool is the only owner; a {@link ChannelLease} is the only way the rest of the adapter touches it.
 */
final class PooledSession {

    private final ClientSession session;
    private final SshClient client;
    private final boolean tty;
    private final Semaphore permits;
    private final int rejectionLimit;
    private final Clock clock;
    private final Consumer<PooledSession> onUnfit;
    private final AtomicInteger leases = new AtomicInteger();
    private final AtomicInteger rejections = new AtomicInteger();
    private final AtomicBoolean retired = new AtomicBoolean();
    private final AtomicBoolean stopStarted = new AtomicBoolean();
    private volatile Instant lastUsed;

    /**
     * @param onUnfit what the pool does when the session must leave it (closed with no channel in use, or lost); called at most once per reason, from any thread
     */
    PooledSession(ClientSession session, SshClient client, boolean tty, int channelPermits, int rejectionLimit, Clock clock, Consumer<PooledSession> onUnfit) {
        this.session = session;
        this.client = client;
        this.tty = tty;
        this.permits = new Semaphore(channelPermits);
        this.rejectionLimit = rejectionLimit;
        this.clock = clock;
        this.onUnfit = onUnfit;
        this.lastUsed = clock.instant();
    }

    ClientSession session() {
        return session;
    }

    /** True when the profile of the target allocates a terminal for its commands. */
    boolean tty() {
        return tty;
    }

    /** True while the session is not retired and MINA says it is open. */
    boolean isOpen() {
        return !retired.get() && session.isOpen();
    }

    /** Takes a channel permit without waiting; false when the session already has its permitted number of channels. */
    boolean tryAcquirePermit() {
        if (!permits.tryAcquire()) {
            return false;
        }
        leases.incrementAndGet();
        lastUsed = clock.instant();
        return true;
    }

    /** True when no channel uses the session and it has rested for at least {@code idle}. */
    boolean restedFor(Duration idle) {
        return leases.get() == 0 && !lastUsed.plus(idle).isAfter(clock.instant());
    }

    void openAccepted() {
        rejections.set(0);
    }

    void openRejected() {
        rejections.incrementAndGet();
    }

    /** Gives a permit back; a session that has refused channels {@code rejectionLimit} times in a row and has no channel in use is closed. */
    void release() {
        permits.release();
        int inUse = leases.decrementAndGet();
        lastUsed = clock.instant();
        if (inUse == 0 && rejections.get() >= rejectionLimit) {
            unfit();
        }
    }

    /** The transport is lost: the session leaves the pool at once. */
    void lost() {
        unfit();
    }

    /** Marks the session as no longer usable (first call only) and tells the pool. */
    void unfit() {
        if (retired.compareAndSet(false, true)) {
            onUnfit.accept(this);
        }
    }

    /** True once the session left the pool; a retired session is never leased again. */
    boolean retired() {
        return retired.get();
    }

    /** Closes the session by stopping its client; blocks up to MINA's stop wait, so it is never called from a MINA thread. */
    void stop() {
        retired.set(true);
        if (stopStarted.compareAndSet(false, true)) {
            client.stop();
        }
    }
}
