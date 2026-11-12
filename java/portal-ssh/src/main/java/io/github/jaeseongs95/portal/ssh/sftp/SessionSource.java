package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.app.remote.CancelToken;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;

/**
 * Where the file adapter gets an authenticated SSH session from: the narrow collaborator it needs from the session pool (stage 3 design 3.5). The adapter never
 * connects, authenticates or checks a host key itself; it asks for a lease, works on the session and gives the lease back. The pool that implements this keeps the
 * sessions alive, checks them before it hands them out and decides about a dead one, so the file adapter has no reconnect path (a request that may have reached the
 * target is never sent again).
 *
 * <p>The answer is a value and not an exception: a session that cannot be had is {@link SessionAcquisition.Unavailable} with the reason the request ends with.
 */
@FunctionalInterface
public interface SessionSource {

    /**
     * Leases a session for the profile of the target.
     *
     * @param target where the request goes and with which profile
     * @param cancel the owner's request to stop; a connection in progress is given up when it fires
     * @return the lease, or why there is none
     */
    SessionAcquisition lease(RemoteTarget target, CancelToken cancel);
}
