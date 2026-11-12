package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * The {@code data} of {@code desktop-observe} (public-contract.mjs:254-255, {@code frameData}): the fields of {@link SessionData} and, on the same object, the
 * description of one captured frame. The PNG itself is not part of the data: it travels as the second content item, and {@code imageContentIndex} says which.
 *
 * <p>The wire object is flat, so the record repeats the session's components instead of nesting one; the constructor checks them by building a
 * {@link SessionData}, so the rules live in one place. {@code nextInputSequence} is required here, where a session may leave it out. {@code coordinateSpace},
 * {@code mimeType} and {@code imageContentIndex} are constants of the contract ({@link #COORDINATE_SPACE}, {@link #MIME_TYPE}, {@link #IMAGE_CONTENT_INDEX}).
 * The optional components are left out of the object when null, as in {@link SessionData}; a null {@code lastInputReceipt} is the wire null (null = wire null).
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record FrameData(String sessionId, long epoch, String targetId, String targetRevision, long expiresAt, long idleExpiresAt, String kind,
                        @JsonInclude(JsonInclude.Include.NON_NULL) DesktopReadinessData readiness,
                        @JsonInclude(JsonInclude.Include.NON_NULL) DesktopCapabilitiesData capabilities,
                        @JsonInclude(JsonInclude.Include.NON_NULL) GuiLifecycleWire lifecycle, long nextInputSequence, InputReceipt lastInputReceipt, String frameId,
                        long width, long height, long geometryRevision, String coordinateSpace, String mimeType, long imageContentIndex) {

    /** Pixels are physical, not scaled. */
    public static final String COORDINATE_SPACE = "physical-pixels";
    /** The only image type of a frame. */
    public static final String MIME_TYPE = "image/png";
    /** The position of the image among the content items of the answer: the data is item 0, the image item 1. */
    public static final long IMAGE_CONTENT_INDEX = 1L;
    /** The longest frame id, in UTF-16 units as the 2.x schema counts them. */
    public static final int MAX_FRAME_ID_LENGTH = 96;

    public FrameData {
        new SessionData(sessionId, epoch, targetId, targetRevision, expiresAt, idleExpiresAt, kind, readiness, capabilities, lifecycle, nextInputSequence,
            lastInputReceipt);
        WireNumber.POSITIVE.require(nextInputSequence, "nextInputSequence");
        if (frameId == null || frameId.isEmpty() || frameId.length() > MAX_FRAME_ID_LENGTH) {
            throw new IllegalArgumentException("frameId must have 1 to " + MAX_FRAME_ID_LENGTH + " characters");
        }
        WireNumber.POSITIVE.require(width, "width");
        WireNumber.POSITIVE.require(height, "height");
        WireNumber.POSITIVE.require(geometryRevision, "geometryRevision");
        if (!COORDINATE_SPACE.equals(coordinateSpace)) {
            throw new IllegalArgumentException("coordinateSpace must be " + COORDINATE_SPACE);
        }
        if (!MIME_TYPE.equals(mimeType)) {
            throw new IllegalArgumentException("mimeType must be " + MIME_TYPE);
        }
        if (imageContentIndex != IMAGE_CONTENT_INDEX) {
            throw new IllegalArgumentException("imageContentIndex must be " + IMAGE_CONTENT_INDEX);
        }
    }
}
