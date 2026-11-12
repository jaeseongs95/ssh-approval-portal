package io.github.jaeseongs95.portal.domain.failure;

import java.util.Objects;

/**
 * The diagnosis of an operation that was stopped before any external effect: a fixed reason and the step it happened at, nothing else. An exception's text and
 * its properties are never diagnostic input (2.x dispatch-failure.mjs:1), so this type holds two enums and no message; the text of a failure travels as the
 * {@code cause} of the exception that carries it and is never shown.
 *
 * <p>{@link Refused} is a decision to stop (a guard said no), {@link StepFailed} a step that failed unexpectedly, {@link Unclassified} a failure nobody classified.
 * All three have the same effect on the operation; the difference is only for the audit trail.
 */
public sealed interface DispatchFailure permits DispatchFailure.Refused, DispatchFailure.StepFailed, DispatchFailure.Unclassified {

    DispatchReason reason();

    DispatchStage stage();

    /** A guard refused the operation (2.x dispatchRefusal). */
    static DispatchFailure refused(DispatchReason reason, DispatchStage stage) {
        return new Refused(reason, stage);
    }

    /** A step failed with a fixed reason (2.x dispatchStep). */
    static DispatchFailure stepFailed(DispatchStage stage, DispatchReason reason) {
        return new StepFailed(stage, reason);
    }

    /** A guard refused the operation. */
    record Refused(DispatchReason reason, DispatchStage stage) implements DispatchFailure {

        public Refused {
            requireKnownPair(reason, stage);
        }
    }

    /** A step failed. */
    record StepFailed(DispatchStage stage, DispatchReason reason) implements DispatchFailure {

        public StepFailed {
            requireKnownPair(reason, stage);
        }
    }

    /** Nothing classified the failure: reason and stage are both {@code unknown} (2.x dispatch-failure.mjs:20-23). */
    record Unclassified() implements DispatchFailure {

        @Override
        public DispatchReason reason() {
            return DispatchReason.UNKNOWN;
        }

        @Override
        public DispatchStage stage() {
            return DispatchStage.UNKNOWN;
        }
    }

    private static void requireKnownPair(DispatchReason reason, DispatchStage stage) {
        Objects.requireNonNull(reason, "reason");
        Objects.requireNonNull(stage, "stage");
        if (!stage.accepts(reason)) {
            throw new IllegalArgumentException("Invalid dispatch diagnostic: " + reason + " is not a reason for " + stage);
        }
    }
}
