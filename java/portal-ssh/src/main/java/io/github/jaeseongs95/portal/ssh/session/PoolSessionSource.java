package io.github.jaeseongs95.portal.ssh.session;

import java.util.Objects;

import org.apache.sshd.client.session.ClientSession;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.remote.CancelToken;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.ssh.sftp.SessionAcquisition;
import io.github.jaeseongs95.portal.ssh.sftp.SessionLease;
import io.github.jaeseongs95.portal.ssh.sftp.SessionSource;

/**
 * The session pool as the file adapter sees it: {@link SessionSource} over {@link SshSessionPool#acquire}. The file adapter asks for a lease and never connects, checks a host
 * key or reconnects itself (stage 3 design 3.5), so every way the pool can fail to give a session is an {@link SessionAcquisition.Unavailable} with the cause that the request
 * ends with: a connection that could not be made is {@code CONNECT_FAILED}, a session that already has its permitted channels open is {@code CHANNEL_OPEN_FAILED} (no channel
 * was opened), and a cancel is {@code CANCELLED}. Nothing was sent to the target in any of them.
 *
 * <p>The lease of the file adapter is the pool's {@link ChannelLease}: closing it gives the permit back, and discarding it says the transport is lost ({@code sessionLost}).
 */
@Component
public final class PoolSessionSource implements SessionSource {

    private final SshSessionPool pool;

    public PoolSessionSource(SshSessionPool pool) {
        this.pool = Objects.requireNonNull(pool, "pool");
    }

    @Override
    public SessionAcquisition lease(RemoteTarget target, CancelToken cancel) {
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(cancel, "cancel");
        return switch (pool.acquire(target.profile(), cancel)) {
            case AcquireResult.Leased leased -> new SessionAcquisition.Acquired(new PooledLease(leased.lease()));
            case AcquireResult.Failed failed -> new SessionAcquisition.Unavailable(TransferFailureCause.CONNECT_FAILED);
            case AcquireResult.NoChannelPermit noPermit -> new SessionAcquisition.Unavailable(TransferFailureCause.CHANNEL_OPEN_FAILED);
            case AcquireResult.Cancelled cancelled -> new SessionAcquisition.Unavailable(TransferFailureCause.CANCELLED);
        };
    }

    /** One use of a pooled session, in the terms of the file adapter. */
    private record PooledLease(ChannelLease lease) implements SessionLease {

        @Override
        public ClientSession session() {
            return lease.session();
        }

        @Override
        public void discard() {
            lease.sessionLost();
        }

        @Override
        public void close() {
            lease.close();
        }
    }
}
