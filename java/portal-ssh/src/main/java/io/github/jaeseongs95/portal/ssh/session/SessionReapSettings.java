package io.github.jaeseongs95.portal.ssh.session;

import java.time.Duration;
import java.util.Objects;

/**
 * When the pool closes a session nobody uses (vendor rule CR-08, {@code connectionIdleReapMs}, default 900000 ms; VR-419). A session with no channel in use that nobody has
 * leased for {@code idleAfter} is closed by a sweep that runs every {@code sweepEvery}; a session with a channel in use is never closed by the sweep. The jump hosts of a
 * connection are not sessions of their own in this pool (a connection is one MINA client that owns its whole chain), so closing the connection closes them and no jump host is
 * closed while the connection that uses it is in use (VR-416).
 *
 * <p>This is a value object of the session package because {@code SshSettings} (the record of {@code app.remote}) has no field for it; stage 4's property binding supplies it.
 *
 * @param idleAfter how long a session may rest before the sweep closes it
 * @param sweepEvery how often the sweep looks
 */
public record SessionReapSettings(Duration idleAfter, Duration sweepEvery) {

    /** 2.x {@code connectionIdleReapMs}: 15 minutes. */
    public static final Duration DEFAULT_IDLE_AFTER = Duration.ofMinutes(15);
    /** How often the sweep looks by default. */
    public static final Duration DEFAULT_SWEEP_EVERY = Duration.ofMinutes(1);

    public SessionReapSettings {
        Objects.requireNonNull(idleAfter, "idleAfter");
        Objects.requireNonNull(sweepEvery, "sweepEvery");
        if (idleAfter.isZero() || idleAfter.isNegative() || sweepEvery.isZero() || sweepEvery.isNegative()) {
            throw new IllegalArgumentException("idleAfter and sweepEvery must be positive");
        }
    }

    /** The 2.x value: 15 minutes idle, looked at every minute. */
    public static SessionReapSettings defaults() {
        return new SessionReapSettings(DEFAULT_IDLE_AFTER, DEFAULT_SWEEP_EVERY);
    }
}
