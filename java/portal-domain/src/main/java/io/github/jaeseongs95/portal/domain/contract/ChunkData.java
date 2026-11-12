package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;

/** The {@code data} of {@code artifact-chunk} (public-contract.mjs:65, {@code chunkData}): the sequence the portal acknowledged and the bytes it holds so far. */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record ChunkData(long sequence, long received) {

    public ChunkData {
        WireNumber.NON_NEGATIVE.require(sequence, "sequence");
        WireNumber.NON_NEGATIVE.require(received, "received");
    }
}
