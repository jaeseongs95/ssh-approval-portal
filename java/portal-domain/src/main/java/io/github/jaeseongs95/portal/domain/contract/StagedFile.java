package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import java.util.Objects;

/**
 * A file the agent's own computer uploaded to the portal and that waits to be placed on a target (public-contract.mjs:68-72, {@code stagedFile}). The file name is
 * 1 to 255 UTF-16 units, as the 2.x schema counts them, the size is at most 64 MiB and {@code expiresAt} is epoch milliseconds. No local or internal path is part of
 * it.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record StagedFile(String uuid, StagedFileStateWire state, String fileName, long size, String sha256, long expiresAt, long received, long sequence,
                         List<StagedOperation> operations) {

    /** The longest file name. */
    public static final int MAX_FILE_NAME_LENGTH = 255;

    public StagedFile {
        WireFormat.UUID.require(uuid, "uuid");
        Objects.requireNonNull(state, "state");
        Objects.requireNonNull(fileName, "fileName");
        if (fileName.isEmpty() || fileName.length() > MAX_FILE_NAME_LENGTH) {
            throw new IllegalArgumentException("fileName must have 1 to " + MAX_FILE_NAME_LENGTH + " characters");
        }
        WireNumber.ARTIFACT_BYTES.require(size, "size");
        WireFormat.DIGEST.require(sha256, "sha256");
        WireNumber.NON_NEGATIVE.require(expiresAt, "expiresAt");
        WireNumber.NON_NEGATIVE.require(received, "received");
        WireNumber.NON_NEGATIVE.require(sequence, "sequence");
        operations = List.copyOf(operations);
    }
}
