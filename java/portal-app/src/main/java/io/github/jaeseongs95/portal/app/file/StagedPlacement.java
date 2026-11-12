package io.github.jaeseongs95.portal.app.file;

import java.util.Objects;

import io.github.jaeseongs95.portal.app.artifact.ArtifactRefusal;
import io.github.jaeseongs95.portal.app.artifact.StagedActionState;
import io.github.jaeseongs95.portal.domain.id.OperationId;

/** How a copy or a move of a staged file was answered: an operation exists for it (new, or the one of an earlier call with the same key), or the bytes could not be reserved. */
public sealed interface StagedPlacement permits StagedPlacement.Placed, StagedPlacement.Refused {

    /**
     * The upload exists.
     *
     * @param operation the operation that publishes the file
     * @param state the state of the action on the staged file: {@code SUBMITTED} while the operation runs, {@code SETTLED} once it ended
     */
    record Placed(OperationId operation, StagedActionState state) implements StagedPlacement {

        public Placed {
            Objects.requireNonNull(operation, "operation");
            Objects.requireNonNull(state, "state");
        }
    }

    /** The copy of the staged file could not be reserved (the budget or the disk refused); nothing was admitted and nothing is left. */
    record Refused(ArtifactRefusal refusal) implements StagedPlacement {

        public Refused {
            Objects.requireNonNull(refusal, "refusal");
        }
    }
}
