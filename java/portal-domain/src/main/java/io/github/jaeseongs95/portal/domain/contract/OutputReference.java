package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Objects;

/**
 * Where the captured output of an operation is kept and what is known of it (public-contract.mjs:16-18, {@code outputReference}). {@code version},
 * {@code captureSource} and {@code sshCompleteness} are constants of the contract; {@link #of} fills them. A null component is the wire null (null = wire null):
 * an output that is still {@code pending} has no id, no size and no digest yet.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record OutputReference(long version, String captureSource, String sshCompleteness, String id, OutputReferenceStateWire state, Long bytes, Long snapshotBytes,
                              String sha256, Long expiresAt) {

    /** The contract's output reference version. */
    public static final long VERSION = 1L;
    /** The output is the adapter's result after redaction, not raw bytes from the wire. */
    public static final String CAPTURE_SOURCE = "redacted-adapter-outcome";
    /** The SSH layer cannot say whether it saw everything the command wrote. */
    public static final String SSH_COMPLETENESS = "unknown";

    public OutputReference {
        if (version != VERSION) {
            throw new IllegalArgumentException("version must be " + VERSION);
        }
        if (!CAPTURE_SOURCE.equals(captureSource)) {
            throw new IllegalArgumentException("captureSource must be " + CAPTURE_SOURCE);
        }
        if (!SSH_COMPLETENESS.equals(sshCompleteness)) {
            throw new IllegalArgumentException("sshCompleteness must be " + SSH_COMPLETENESS);
        }
        WireFormat.IDENTIFIER.requireOrNull(id, "id");
        Objects.requireNonNull(state, "state");
        WireNumber.NON_NEGATIVE.requireOrNull(bytes, "bytes");
        WireNumber.NON_NEGATIVE.requireOrNull(snapshotBytes, "snapshotBytes");
        WireFormat.DIGEST.requireOrNull(sha256, "sha256");
        WireNumber.NON_NEGATIVE.requireOrNull(expiresAt, "expiresAt");
    }

    /** An output reference with the constants of the contract filled in. */
    public static OutputReference of(String id, OutputReferenceStateWire state, Long bytes, Long snapshotBytes, String sha256, Long expiresAt) {
        return new OutputReference(VERSION, CAPTURE_SOURCE, SSH_COMPLETENESS, id, state, bytes, snapshotBytes, sha256, expiresAt);
    }
}
