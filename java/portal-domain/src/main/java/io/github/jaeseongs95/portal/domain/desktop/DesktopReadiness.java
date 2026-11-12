package io.github.jaeseongs95.portal.domain.desktop;

import java.time.Instant;
import java.util.List;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.desktop.DesktopGeneration.NoGeneration;
import io.github.jaeseongs95.portal.domain.desktop.DesktopOsSessionId.NoOsSessionId;
import io.github.jaeseongs95.portal.domain.desktop.DesktopSessionRef.NoSessionRef;

/**
 * The status of a desktop as a trusted host adapter observed it, never as a desktop request claims it (2.x desktop-state.mjs:7-30). The record refuses a status
 * that contradicts itself:
 * <ul>
 * <li>{@code DESKTOP_READY} needs the session binding, the display binding and the input all verified, a session that is not locked, a session identity (a
 * session reference, or an operating-system session id with a lock known to be {@code UNLOCKED}) and a generation (the resource generation or the generation);</li>
 * <li>{@code CAPTURE_UNAVAILABLE} cannot allow input.</li>
 * </ul>
 * A part that may be missing is a sealed variant ({@link DesktopGeneration}, {@link DesktopOsSessionId}, {@link DesktopSessionRef}) or a {@link LockState}
 * that says {@code UNKNOWN}; there is no null and no {@code Optional} in the record.
 */
public record DesktopReadiness(DesktopState state, Instant observedAt, DesktopGeneration generation, DesktopOsSessionId osSessionId, LockState locked,
        boolean sessionBindingVerified, boolean displayBindingVerified, boolean inputVerified, boolean inputAllowed, boolean ownerOnly,
        List<DesktopBlocker> blockers, DesktopSessionRef sessionRef, DesktopGeneration resourceGeneration) {

    public static final int MAX_BLOCKERS = 8;

    public DesktopReadiness {
        Objects.requireNonNull(state, "state");
        Objects.requireNonNull(observedAt, "observedAt");
        Objects.requireNonNull(generation, "generation");
        Objects.requireNonNull(osSessionId, "osSessionId");
        Objects.requireNonNull(locked, "locked");
        Objects.requireNonNull(sessionRef, "sessionRef");
        Objects.requireNonNull(resourceGeneration, "resourceGeneration");
        blockers = List.copyOf(Objects.requireNonNull(blockers, "blockers"));
        if (observedAt.isBefore(Instant.EPOCH)) {
            throw new IllegalArgumentException("A desktop observation time is not before the epoch");
        }
        if (blockers.size() > MAX_BLOCKERS) {
            throw new IllegalArgumentException("A desktop status has at most " + MAX_BLOCKERS + " blockers");
        }
        if (state == DesktopState.DESKTOP_READY) {
            requireReady(sessionBindingVerified && displayBindingVerified && inputVerified, locked, sessionRef, osSessionId, generation, resourceGeneration);
        }
        if (state == DesktopState.CAPTURE_UNAVAILABLE && inputAllowed) {
            throw new IllegalArgumentException("A desktop whose capture is unavailable cannot allow input");
        }
    }

    /**
     * The status an existing backend reports from its handshake alone: the connection works, nothing is verified and the session binding is the one blocker.
     * A handshake never says the desktop is ready (2.x {@code transportDesktopState}).
     */
    public static DesktopReadiness transportReady(Instant observedAt) {
        return new DesktopReadiness(DesktopState.TRANSPORT_READY, observedAt, new NoGeneration(), new NoOsSessionId(), LockState.UNKNOWN, false, false, false,
                true, false, List.of(DesktopBlocker.DESKTOP_SESSION_BINDING_UNVERIFIED), new NoSessionRef(), new NoGeneration());
    }

    private static void requireReady(boolean verified, LockState locked, DesktopSessionRef sessionRef, DesktopOsSessionId osSessionId,
            DesktopGeneration generation, DesktopGeneration resourceGeneration) {
        boolean identified = sessionRef.isPresent() || osSessionId.isPresent() && locked == LockState.UNLOCKED;
        boolean generated = resourceGeneration.isPresent() || generation.isPresent();
        if (!verified || locked == LockState.LOCKED || !identified || !generated) {
            throw new IllegalArgumentException("A ready desktop needs verified bindings and input, an unlocked session, a session identity and a generation");
        }
    }
}
