package io.github.jaeseongs95.portal.ssh.session;

import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import java.util.Objects;

/**
 * A session that could not be made.
 *
 * @param cause why
 * @param hop the profile the failure belongs to: the target's own profile, or the jump profile that was not passed (stage 3 design 3.6, "ProxyJump via ... failed");
 *            best effort, because MINA reports a chain as one connection
 */
public record ConnectFailure(ConnectFailureCause cause, ProfileAlias hop) {
    public ConnectFailure {
        Objects.requireNonNull(cause, "cause");
        Objects.requireNonNull(hop, "hop");
    }
}
