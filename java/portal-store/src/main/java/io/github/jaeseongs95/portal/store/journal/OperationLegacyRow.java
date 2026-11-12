package io.github.jaeseongs95.portal.store.journal;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

/**
 * Table {@code operation_legacy}: the original text of an operation imported from 2.x (stage 7 writes it). {@code originalText} is the long-text column of the vendor
 * script V1_1. The journal reads the table only to leave imported rows out of the live unknown count.
 */
@Table("operation_legacy")
public record OperationLegacyRow(@Id String operationId, String legacySource, long originalBytes, long reservedBytes, String legacyDigest, String originalText) {
}
