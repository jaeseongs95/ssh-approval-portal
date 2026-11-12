package io.github.jaeseongs95.portal.ssh.session;

import java.util.concurrent.atomic.AtomicBoolean;
import org.apache.sshd.client.session.ClientSession;

/**
 * The right to open one channel on a pooled session: it holds one of the session's channel permits until it is closed. The holder reports what the server did with
 * the channel open, so the pool can tell a session that refuses channels (three in a row and no channel in use: the session is closed) from one that does not.
 */
public final class ChannelLease implements AutoCloseable {

    private final PooledSession pooled;
    private final AtomicBoolean closed = new AtomicBoolean();

    ChannelLease(PooledSession pooled) {
        this.pooled = pooled;
    }

    /** The session to open the channel on. */
    public ClientSession session() {
        return pooled.session();
    }

    /** True when the channel is to get a terminal: the profile of the target says {@code tty} (2.x: {@code xterm-256color}, 200 columns, 50 lines; VR-434). */
    public boolean tty() {
        return pooled.tty();
    }

    /** The server opened the channel: the run of refusals ends. */
    public void openAccepted() {
        pooled.openAccepted();
    }

    /** The server refused the channel open (or the open failed on a live session). */
    public void openRejected() {
        pooled.openRejected();
    }

    /** The session is dead (the transport is lost): it is closed and left out of the pool, whatever else uses it. */
    public void sessionLost() {
        pooled.lost();
    }

    /** Gives the permit back; the first call counts, later calls do nothing. */
    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) {
            pooled.release();
        }
    }
}
