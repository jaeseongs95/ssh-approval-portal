package io.github.jaeseongs95.portal.ssh.sftp;

import org.apache.sshd.client.session.ClientSession;

/**
 * One use of a pooled session. Closing the lease gives the session back; {@link #discard()} says the session cannot be trusted any more (the connection broke while
 * a request was under way), so the pool drops it and the next request gets a new one. It never makes the pool send anything again.
 */
public interface SessionLease extends AutoCloseable {

    /** The authenticated session; valid until the lease is closed or discarded. */
    ClientSession session();

    /** The session is dead or its state is unknown: the pool must not hand it out again. */
    void discard();

    /** Gives the session back to the pool (or closes it when it was discarded). Never throws. */
    @Override
    void close();
}
