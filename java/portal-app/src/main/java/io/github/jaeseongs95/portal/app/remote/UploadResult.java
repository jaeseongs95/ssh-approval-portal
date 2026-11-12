package io.github.jaeseongs95.portal.app.remote;

import java.time.Instant;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.operation.CompletionEvidence;

/**
 * How an upload ended. The variants tell a confirmed refusal (the target is unchanged) from an outcome that is not known, so an upload is a completed operation only
 * through {@link Published}, which exists only after the replacement was confirmed (defect D-0035).
 */
public sealed interface UploadResult permits UploadResult.Published, UploadResult.Refused, UploadResult.RolledBack, UploadResult.Unconfirmed,
    UploadResult.NotDispatched {

    /**
     * The file is in place and the replacement is confirmed: the target was read after the replacement and shows the announced content.
     *
     * @param sha256 the digest of the published content
     * @param confirmedAt when the replacement was confirmed
     * @param method how the file was put in place
     */
    record Published(Digest sha256, Instant confirmedAt, ReplaceMethod method) implements UploadResult {

        public Published {
            Objects.requireNonNull(sha256, "sha256");
            Objects.requireNonNull(confirmedAt, "confirmedAt");
            Objects.requireNonNull(method, "method");
        }

        /** The evidence that lets the operation settle as completed. */
        public CompletionEvidence evidence() {
            return new CompletionEvidence.FilePublished(confirmedAt, sha256);
        }
    }

    /**
     * The target refused before the replacement; it is unchanged, which is confirmed.
     *
     * @param code why
     * @param diagnostic the closed fact behind the code
     * @param cleanup whether the temporary file is confirmed removed
     */
    record Refused(TransferErrorCode code, FileDiagnostic diagnostic, CleanupState cleanup) implements UploadResult {

        public Refused {
            Objects.requireNonNull(code, "code");
            Objects.requireNonNull(diagnostic, "diagnostic");
            Objects.requireNonNull(cleanup, "cleanup");
        }
    }

    /**
     * The replacement happened and then failed, and the original is confirmed back in place: a failure, never a completion.
     *
     * @param code why
     * @param diagnostic the closed fact behind the code
     * @param restored the proof that the original is back
     */
    record RolledBack(TransferErrorCode code, FileDiagnostic diagnostic, RestoreEvidence restored) implements UploadResult {

        public RolledBack {
            Objects.requireNonNull(code, "code");
            Objects.requireNonNull(diagnostic, "diagnostic");
            Objects.requireNonNull(restored, "restored");
        }
    }

    /**
     * The state of the target is not known: the owner reconciles it.
     *
     * @param cause why it is not known
     * @param cleanup whether the temporary file is confirmed removed
     */
    record Unconfirmed(UnconfirmedCause cause, CleanupState cleanup) implements UploadResult {

        public Unconfirmed {
            Objects.requireNonNull(cause, "cause");
            Objects.requireNonNull(cleanup, "cleanup");
        }
    }

    /**
     * The upload did not get to write anything: the connection, the channel or the SFTP subsystem failed, the time ran out or the owner cancelled before the first
     * write. The target is unchanged.
     *
     * @param cause why
     */
    record NotDispatched(TransferFailureCause cause) implements UploadResult {

        public NotDispatched {
            Objects.requireNonNull(cause, "cause");
        }
    }
}
