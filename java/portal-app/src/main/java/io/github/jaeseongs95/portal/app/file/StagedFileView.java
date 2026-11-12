package io.github.jaeseongs95.portal.app.file;

import java.util.List;
import java.util.Objects;

import io.github.jaeseongs95.portal.app.artifact.ArtifactRecord;
import io.github.jaeseongs95.portal.app.artifact.StagedAction;

/** A staged file as its owner sees it: the stored record and the actions made on it, in operation-key order. */
public record StagedFileView(ArtifactRecord artifact, List<StagedAction> actions) {

    public StagedFileView {
        Objects.requireNonNull(artifact, "artifact");
        actions = List.copyOf(actions);
    }
}
