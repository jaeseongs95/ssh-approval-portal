package io.github.jaeseongs95.portal.store.artifact;

import java.util.List;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.ArtifactId;

/**
 * What {@link ArtifactStartupCheck#reconcile()} did: the payload files without metadata that went to quarantine, the files cut back to the acknowledged length,
 * the rows in {@code DELETING} that were finished, and the rows still in {@code CONSUMING} that the use case has to finish (the check does not know whether the
 * file was moved or removed).
 */
public record ArtifactReconciliation(List<ArtifactId> quarantined, List<ArtifactId> truncated, List<ArtifactId> deleted, List<ArtifactId> unfinishedConsumptions) {

    public ArtifactReconciliation {
        quarantined = List.copyOf(Objects.requireNonNull(quarantined, "quarantined"));
        truncated = List.copyOf(Objects.requireNonNull(truncated, "truncated"));
        deleted = List.copyOf(Objects.requireNonNull(deleted, "deleted"));
        unfinishedConsumptions = List.copyOf(Objects.requireNonNull(unfinishedConsumptions, "unfinishedConsumptions"));
    }
}
