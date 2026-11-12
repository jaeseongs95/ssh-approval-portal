package io.github.jaeseongs95.portal.store.journal;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

/** Table {@code operation_slot}: a taken concurrency slot; the primary key is {@code (scope, slot_no)} (design 13.2), so the row is only inserted, read and deleted. */
@Table("operation_slot")
public record OperationSlotRow(@Id String scope, int slotNo, String operationId) {
}
