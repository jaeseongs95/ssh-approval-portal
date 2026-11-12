package io.github.jaeseongs95.portal.domain.operation;

import io.github.jaeseongs95.portal.domain.id.Digest;
import java.time.Instant;
import java.util.Objects;

/**
 * What proves that an operation did what it was asked to. An operation is completed only with evidence that confirms it (defect D-0035: a file transfer that
 * reported success before the replacement was final). There is no evidence-free way to build a completed result: {@link Operation#settle} turns an outcome without
 * confirming evidence into an unknown one, which the owner reconciles, never into a completed one.
 */
public sealed interface CompletionEvidence permits CompletionEvidence.NoEvidence, CompletionEvidence.CommandExited, CompletionEvidence.FilePublished,
    CompletionEvidence.FileRead {

    /** True when the evidence proves the operation completed. */
    boolean confirmsCompletion();

    /** Nothing was confirmed: an operation that did not run, or one whose end was not seen. */
    record NoEvidence() implements CompletionEvidence {

        @Override
        public boolean confirmsCompletion() {
            return false;
        }
    }

    /** The command ended with an exit status. Only status 0 confirms completion; another status is the evidence of a failure. */
    record CommandExited(int exitCode) implements CompletionEvidence {

        @Override
        public boolean confirmsCompletion() {
            return exitCode == 0;
        }
    }

    /**
     * An uploaded file was published: it was written to a temporary file, verified and put in place, and the instant is when that was confirmed. A failure after the
     * replacement is rolled back to the original and is a failure, not this evidence.
     */
    record FilePublished(Instant confirmedAt, Digest sha256) implements CompletionEvidence {

        public FilePublished {
            Objects.requireNonNull(confirmedAt, "confirmedAt");
            Objects.requireNonNull(sha256, "sha256");
        }

        @Override
        public boolean confirmsCompletion() {
            return true;
        }
    }

    /** A downloaded file was read to the end; it confirms completion only when its digest matched what was announced. */
    record FileRead(boolean verified) implements CompletionEvidence {

        @Override
        public boolean confirmsCompletion() {
            return verified;
        }
    }
}
