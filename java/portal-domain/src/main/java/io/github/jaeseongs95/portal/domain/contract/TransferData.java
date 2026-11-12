package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * An agent byte upload in progress (public-contract.mjs:61-62, {@code transfer}): how many bytes arrived of how many promised, bound to a target revision. Sizes are
 * bytes, {@code expiresAt} is epoch milliseconds, {@code size} is at most 64 MiB.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record TransferData(String id, long received, long sequence, long size, String sha256, long expiresAt, String targetId, String targetRevision) {

    public TransferData {
        WireFormat.IDENTIFIER.require(id, "id");
        WireNumber.NON_NEGATIVE.require(received, "received");
        WireNumber.NON_NEGATIVE.require(sequence, "sequence");
        WireNumber.ARTIFACT_BYTES.require(size, "size");
        WireFormat.DIGEST.require(sha256, "sha256");
        WireNumber.NON_NEGATIVE.require(expiresAt, "expiresAt");
        WireFormat.TARGET.require(targetId, "targetId");
        WireFormat.DIGEST.require(targetRevision, "targetRevision");
    }
}
