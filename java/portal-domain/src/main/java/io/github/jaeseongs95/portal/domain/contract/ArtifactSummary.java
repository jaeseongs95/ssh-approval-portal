package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Objects;

/** The file a completed download operation holds (public-contract.mjs:21, {@code artifact}): its name, its size in bytes and its SHA-256. */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record ArtifactSummary(String fileName, long size, String sha256) {

    public ArtifactSummary {
        Objects.requireNonNull(fileName, "fileName");
        WireNumber.NON_NEGATIVE.require(size, "size");
        WireFormat.DIGEST.require(sha256, "sha256");
    }
}
