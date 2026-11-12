package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * The {@code data} of {@code artifact-begin} (public-contract.mjs:63, {@code beginData}): the fields of {@link TransferData} and, on the same object, the chunk size
 * the portal accepts. The wire object is flat, so the record repeats the transfer's components instead of nesting one; the constructor checks them by building a
 * {@link TransferData}, so the rules live in one place. {@code maxChunkBytes} is a constant of the contract (262144); {@link #of} fills it.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record BeginData(String id, long received, long sequence, long size, String sha256, long expiresAt, String targetId, String targetRevision, long maxChunkBytes) {

    /** The chunk size the contract fixes. */
    public static final long MAX_CHUNK_BYTES = WireNumber.CHUNK_BYTES.max();

    public BeginData {
        new TransferData(id, received, sequence, size, sha256, expiresAt, targetId, targetRevision);
        if (maxChunkBytes != MAX_CHUNK_BYTES) {
            throw new IllegalArgumentException("maxChunkBytes must be " + MAX_CHUNK_BYTES);
        }
    }

    /** The begin data of a transfer, with the chunk size of the contract filled in. */
    public static BeginData of(TransferData transfer) {
        return new BeginData(transfer.id(), transfer.received(), transfer.sequence(), transfer.size(), transfer.sha256(), transfer.expiresAt(), transfer.targetId(),
            transfer.targetRevision(), MAX_CHUNK_BYTES);
    }
}
