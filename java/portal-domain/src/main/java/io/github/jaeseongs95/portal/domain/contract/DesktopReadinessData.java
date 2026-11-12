package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import java.util.Objects;

/**
 * What the portal knows of whether a desktop can be used (public-contract.mjs:246-250, {@code desktopReadiness}). {@code transport_ready} is not
 * {@code desktop_ready}. {@code observedAt} is epoch milliseconds, {@code generation} and {@code resourceGeneration} are SHA-256 digests.
 *
 * <p>A null {@code generation}, {@code sessionRef}, {@code resourceGeneration}, {@code osSessionId} or {@code locked} is the wire null (null = wire null). The
 * baseline makes {@code sessionRef} and {@code resourceGeneration} optional and nullable, so a null is written, not left out. At most eight blockers are listed.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record DesktopReadinessData(DesktopReadinessStateWire state, long observedAt, String generation, String sessionRef, String resourceGeneration, Long osSessionId,
                                   Boolean locked, boolean sessionBindingVerified, boolean displayBindingVerified, boolean inputVerified, boolean inputAllowed,
                                   boolean ownerOnly, List<DesktopBlockerWire> blockers) {

    /** The most blockers a readiness object lists. */
    public static final int MAX_BLOCKERS = 8;

    public DesktopReadinessData {
        Objects.requireNonNull(state, "state");
        WireNumber.NON_NEGATIVE.require(observedAt, "observedAt");
        WireFormat.DIGEST.requireOrNull(generation, "generation");
        WireFormat.SESSION_REF.requireOrNull(sessionRef, "sessionRef");
        WireFormat.DIGEST.requireOrNull(resourceGeneration, "resourceGeneration");
        WireNumber.POSITIVE.requireOrNull(osSessionId, "osSessionId");
        blockers = List.copyOf(blockers);
        if (blockers.size() > MAX_BLOCKERS) {
            throw new IllegalArgumentException("blockers has more than " + MAX_BLOCKERS + " entries");
        }
    }
}
