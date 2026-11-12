package io.github.jaeseongs95.portal.domain.error;

import java.util.Objects;

/**
 * The diagnosis of an execution that failed after the external effect may have started: the step, a fixed error code and what is known about the remote side. It
 * holds three enums and no text, so an error message never becomes diagnostic data (2.x execution-failure.mjs:1). An execution is never replayed automatically,
 * whatever the diagnosis says, so there is no field for it. The text of the real error reaches the owner through the result's diagnostic, not through this type.
 */
public sealed interface ExecutionFailure permits ExecutionFailure.Classified, ExecutionFailure.Unclassified {

    ExecutionStage stage();

    ExecutionErrorCode code();

    RemoteOutcome remoteOutcome();

    /** A failure the adapter classified: the code must belong to the stage. */
    record Classified(ExecutionStage stage, ExecutionErrorCode code, RemoteOutcome remoteOutcome) implements ExecutionFailure {

        public Classified {
            Objects.requireNonNull(stage, "stage");
            Objects.requireNonNull(code, "code");
            Objects.requireNonNull(remoteOutcome, "remoteOutcome");
            if (!stage.accepts(code)) {
                throw new IllegalArgumentException("Invalid execution diagnostic: " + code + " is not an error of " + stage);
            }
        }
    }

    /** A failure nobody classified: stage {@code operation}, code {@code OPERATION_FAILED}, remote outcome {@code unknown} (2.x execution-failure.mjs:6). */
    record Unclassified() implements ExecutionFailure {

        @Override
        public ExecutionStage stage() {
            return ExecutionStage.OPERATION;
        }

        @Override
        public ExecutionErrorCode code() {
            return ExecutionErrorCode.OPERATION_FAILED;
        }

        @Override
        public RemoteOutcome remoteOutcome() {
            return RemoteOutcome.UNKNOWN;
        }
    }
}
