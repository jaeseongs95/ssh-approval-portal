package io.github.jaeseongs95.portal.store.journal;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

/** Table {@code operation_command}: the input of a command operation. The three texts are the long-text columns of the vendor script V1_1. */
@Table("operation_command")
public record OperationCommandRow(@Id String operationId, String commandText, String callerContext, String displayContext) {
}
