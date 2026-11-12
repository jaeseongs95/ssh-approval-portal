package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.operation.CompletionEvidence;

/**
 * How a download ended. A download only reads, so no variant leaves the target changed and none is unknown on the target's side (decision D3-17).
 */
public sealed interface DownloadResult permits DownloadResult.Fetched, DownloadResult.Refused, DownloadResult.TooLarge, DownloadResult.Failed {

    /**
     * The file was read to the end and the sink took every byte. The adapter returns it only after the size read equals the size the target announced and the file did
     * not change while it was read.
     *
     * @param size the bytes read
     * @param sha256 the digest of the bytes read
     */
    record Fetched(long size, Digest sha256) implements DownloadResult {

        public Fetched {
            Objects.requireNonNull(sha256, "sha256");
            if (size < 0) {
                throw new IllegalArgumentException("size must not be negative: " + size);
            }
        }

        /** The evidence that lets the operation settle as completed; a fetched file is verified by construction. */
        public CompletionEvidence evidence() {
            return new CompletionEvidence.FileRead(true);
        }
    }

    /**
     * The target refused: no such file, no permission, an unsafe path, a path outside the allowed root, a file that changed while it was read.
     *
     * @param code why
     * @param diagnostic the closed fact behind the code
     */
    record Refused(TransferErrorCode code, FileDiagnostic diagnostic) implements DownloadResult {

        public Refused {
            Objects.requireNonNull(code, "code");
            Objects.requireNonNull(diagnostic, "diagnostic");
        }
    }

    /**
     * The file is larger than the limit; the adapter found it out before it read a byte.
     *
     * @param actualBytes the size the target announced
     * @param limitBytes the limit of the request
     */
    record TooLarge(long actualBytes, long limitBytes) implements DownloadResult {

        public TooLarge {
            if (limitBytes < 1 || actualBytes <= limitBytes) {
                throw new IllegalArgumentException("A file is too large when its size is above a positive limit");
            }
        }
    }

    /**
     * The read did not finish: the connection failed or was lost, the time ran out, the owner cancelled or the sink failed. Nothing on the target changed.
     *
     * @param cause why
     */
    record Failed(TransferFailureCause cause) implements DownloadResult {

        public Failed {
            Objects.requireNonNull(cause, "cause");
        }
    }
}
