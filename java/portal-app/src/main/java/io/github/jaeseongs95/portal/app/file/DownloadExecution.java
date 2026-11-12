package io.github.jaeseongs95.portal.app.file;

import java.util.Objects;

import io.github.jaeseongs95.portal.app.artifact.ArtifactRecord;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;

/** What a download left behind: the verified artifact and the completed outcome, or only the outcome of a download that stored nothing (and left no byte and no charge). */
public sealed interface DownloadExecution permits DownloadExecution.Stored, DownloadExecution.NotStored {

    /** The outcome the operation settles from. */
    ExecutionOutcome outcome();

    /** The file was read, stored, verified and is {@code READY} for the owner to save. */
    record Stored(ExecutionOutcome outcome, ArtifactRecord artifact) implements DownloadExecution {

        public Stored {
            Objects.requireNonNull(outcome, "outcome");
            Objects.requireNonNull(artifact, "artifact");
        }
    }

    /** Nothing was stored; the reserved bytes are given back. */
    record NotStored(ExecutionOutcome outcome) implements DownloadExecution {

        public NotStored {
            Objects.requireNonNull(outcome, "outcome");
        }
    }
}
