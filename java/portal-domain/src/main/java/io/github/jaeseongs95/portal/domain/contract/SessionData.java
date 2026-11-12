package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * The {@code data} of {@code desktop-open} and {@code desktop-status} (public-contract.mjs:252-253, {@code sessionData}): the lease of one desktop session.
 * {@code expiresAt} and {@code idleExpiresAt} are epoch milliseconds; {@code kind} is the constant {@code "desktop"} ({@link #KIND}).
 *
 * <p>{@code readiness}, {@code capabilities}, {@code lifecycle} and {@code nextInputSequence} are optional on the wire and never null: a null component is left
 * out of the object, not written as null. A null {@code lastInputReceipt} is the wire null (null = wire null): no input was sent yet.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record SessionData(String sessionId, long epoch, String targetId, String targetRevision, long expiresAt, long idleExpiresAt, String kind,
                          @JsonInclude(JsonInclude.Include.NON_NULL) DesktopReadinessData readiness,
                          @JsonInclude(JsonInclude.Include.NON_NULL) DesktopCapabilitiesData capabilities,
                          @JsonInclude(JsonInclude.Include.NON_NULL) GuiLifecycleWire lifecycle,
                          @JsonInclude(JsonInclude.Include.NON_NULL) Long nextInputSequence, InputReceipt lastInputReceipt) {

    /** The only kind of session. */
    public static final String KIND = "desktop";

    public SessionData {
        WireFormat.SESSION_ID.require(sessionId, "sessionId");
        WireNumber.POSITIVE.require(epoch, "epoch");
        WireFormat.TARGET.require(targetId, "targetId");
        WireFormat.DIGEST.require(targetRevision, "targetRevision");
        WireNumber.NON_NEGATIVE.require(expiresAt, "expiresAt");
        WireNumber.NON_NEGATIVE.require(idleExpiresAt, "idleExpiresAt");
        if (!KIND.equals(kind)) {
            throw new IllegalArgumentException("kind must be " + KIND);
        }
        WireNumber.POSITIVE.requireOrNull(nextInputSequence, "nextInputSequence");
    }
}
