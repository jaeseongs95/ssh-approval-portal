package io.github.jaeseongs95.portal.store.artifact;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

import io.github.jaeseongs95.portal.app.artifact.StagedActionKind;
import io.github.jaeseongs95.portal.app.artifact.StagedActionState;
import io.github.jaeseongs95.portal.domain.operation.Elevation;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;

/** Table {@code staged_action}: one use of a staged file (composite key artifact_id + operation_key; insert with {@code JdbcAggregateOperations#insert}). */
@Table("staged_action")
public record StagedActionRow(@Id String artifactId, String operationKey, String requestKey, String inputDigest, String requestId, StagedActionKind action,
                              StagedActionState state, String targetId, String targetRevision, String remotePath, OverwriteMode overwriteMode, Elevation elevation) {
}
