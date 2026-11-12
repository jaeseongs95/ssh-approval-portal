package io.github.jaeseongs95.portal.domain.desktop;

import java.time.Instant;
import java.util.List;

import io.github.jaeseongs95.portal.domain.desktop.DesktopGeneration.GenerationHex;
import io.github.jaeseongs95.portal.domain.desktop.DesktopGeneration.NoGeneration;
import io.github.jaeseongs95.portal.domain.desktop.DesktopOsSessionId.OsSessionNumber;
import io.github.jaeseongs95.portal.domain.desktop.DesktopSessionRef.SessionRefName;

/**
 * A test helper: starts as a valid {@code DESKTOP_READY} status and lets a test change one part before {@link #build()}. The fields are package-private on
 * purpose (a test sets the one it studies); the product type {@link DesktopReadiness} stays an immutable record.
 */
final class DesktopReadinessBuilder {

    DesktopState state = DesktopState.DESKTOP_READY;
    Instant observedAt = Instant.ofEpochMilli(1000);
    DesktopGeneration generation = new GenerationHex("a".repeat(64));
    DesktopOsSessionId osSessionId = new OsSessionNumber(2);
    LockState locked = LockState.UNLOCKED;
    boolean sessionBindingVerified = true;
    boolean displayBindingVerified = true;
    boolean inputVerified = true;
    boolean inputAllowed = true;
    boolean ownerOnly = true;
    List<DesktopBlocker> blockers = List.of();
    DesktopSessionRef sessionRef = new SessionRefName("session-1");
    DesktopGeneration resourceGeneration = new NoGeneration();

    DesktopReadiness build() {
        return new DesktopReadiness(state, observedAt, generation, osSessionId, locked, sessionBindingVerified, displayBindingVerified, inputVerified,
                inputAllowed, ownerOnly, blockers, sessionRef, resourceGeneration);
    }
}
