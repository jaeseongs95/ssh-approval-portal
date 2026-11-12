package io.github.jaeseongs95.portal.store.output;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

import io.github.jaeseongs95.portal.app.output.OutputFormat;

/**
 * Table {@code command_output_format}: where one rendering lies in the {@code .out} file (2.x {@code formats.*.offset/bytes/sha256}). The primary key is
 * ({@code output_id}, {@code format}); {@code @Id} stands on the first column only, so a row is inserted with {@code JdbcAggregateOperations#insert} and removed
 * with a statement, never saved or found by id.
 */
@Table("command_output_format")
public record CommandOutputFormatRow(@Id String outputId, OutputFormat format, long offsetBytes, long sizeBytes, String sha256) {
}
