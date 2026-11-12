package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * The sizes and the wait the portal accepts (public-contract.mjs:57-58, {@code limits}); an agent reads them from {@code targets} before it submits. Sizes are bytes,
 * {@code maxWaitMs} is milliseconds. The values are the owning types' limits: this record only carries them.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record LimitsData(long commandBytes, long sourceBytes, long artifactBytes, long chunkBytes, long outputPageBytes, long maxWaitMs) {

    public LimitsData {
        WireNumber.NON_NEGATIVE.require(commandBytes, "commandBytes");
        WireNumber.NON_NEGATIVE.require(sourceBytes, "sourceBytes");
        WireNumber.NON_NEGATIVE.require(artifactBytes, "artifactBytes");
        WireNumber.NON_NEGATIVE.require(chunkBytes, "chunkBytes");
        WireNumber.NON_NEGATIVE.require(outputPageBytes, "outputPageBytes");
        WireNumber.NON_NEGATIVE.require(maxWaitMs, "maxWaitMs");
    }
}
