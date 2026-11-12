package io.github.jaeseongs95.portal.store.journal;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

/** Table {@code operation_fence}: the conflict key a live operation holds (the SHA-256 of the key, see V1); the primary key is the triple of target, revision and key. */
@Table("operation_fence")
public record OperationFenceRow(@Id String targetId, String targetRevision, String conflictDigest, String operationId) {
}
