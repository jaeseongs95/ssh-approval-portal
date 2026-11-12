package io.github.jaeseongs95.portal.store.journal;

import java.time.Instant;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

import io.github.jaeseongs95.portal.domain.operation.OperationState;

/** Table {@code operation_event}: one row per transition; the primary key is {@code (operation_id, version)}, so the row is only inserted and read, never saved. */
@Table("operation_event")
public record OperationEventRow(@Id String operationId, long version, OperationState state, Instant occurredAt) {
}
