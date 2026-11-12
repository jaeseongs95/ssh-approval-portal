package io.github.jaeseongs95.portal.app.artifact;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/** Where on which target an artifact is meant to go or come from; a staged file has none (it is bound later, per action). */
public sealed interface ArtifactDestination permits ArtifactDestination.Unassigned, ArtifactDestination.Assigned {

    record Unassigned() implements ArtifactDestination {
    }

    record Assigned(RemotePath path, TargetId targetId, TargetRevision targetRevision, BindingKind binding) implements ArtifactDestination {

        public Assigned {
            Objects.requireNonNull(path, "path");
            Objects.requireNonNull(targetId, "targetId");
            Objects.requireNonNull(targetRevision, "targetRevision");
            Objects.requireNonNull(binding, "binding");
        }
    }
}
