package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * What the portal received and kept of one output stream of an execution (public-contract.mjs:23, {@code streamMetadata}). Sizes are bytes, the cursor is the byte
 * position a reader of the output continues from.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record StreamMetadata(long receivedBytes, long retainedBytes, long cursor, boolean truncated) {

    public StreamMetadata {
        WireNumber.NON_NEGATIVE.require(receivedBytes, "receivedBytes");
        WireNumber.NON_NEGATIVE.require(retainedBytes, "retainedBytes");
        WireNumber.NON_NEGATIVE.require(cursor, "cursor");
    }
}
