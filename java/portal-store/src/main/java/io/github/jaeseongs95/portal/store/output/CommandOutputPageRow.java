package io.github.jaeseongs95.portal.store.output;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

import io.github.jaeseongs95.portal.app.output.OutputFormat;

/**
 * Table {@code command_output_page}: the SHA-256 of one 16 KiB page of one rendering (2.x {@code formats.*.chunks}). The primary key is
 * ({@code output_id}, {@code format}, {@code page_no}); see {@link CommandOutputFormatRow} for how such a row is written.
 */
@Table("command_output_page")
public record CommandOutputPageRow(@Id String outputId, OutputFormat format, int pageNo, String sha256) {
}
