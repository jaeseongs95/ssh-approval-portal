package io.github.jaeseongs95.portal.store.journal;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

import io.github.jaeseongs95.portal.domain.operation.Elevation;

/** Table {@code operation_source}: the input of a source operation (the source text itself is never stored). The four texts are columns of the vendor script V1_1. */
@Table("operation_source")
public record OperationSourceRow(@Id String operationId, String planDigest, String sourceSha256, int sourceBytes, String cwd, Elevation elevation, String environmentRevision,
                                 String launcherCommand, String argvJson, String callerContext, String displayContext) {
}
