package io.github.jaeseongs95.portal.store.output;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.output.FormatSpan;
import io.github.jaeseongs95.portal.app.output.OutputBinding;
import io.github.jaeseongs95.portal.app.output.OutputFormat;
import io.github.jaeseongs95.portal.app.output.OutputFormats;
import io.github.jaeseongs95.portal.app.output.OutputId;
import io.github.jaeseongs95.portal.app.output.OutputManifest;
import io.github.jaeseongs95.portal.app.output.OutputState;
import io.github.jaeseongs95.portal.app.output.OutputTarget;
import io.github.jaeseongs95.portal.app.output.StreamInfo;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/**
 * Turns the persistence rows of an output into the types of the port and back. The rows are the store's own (the domain carries no Spring Data annotation), so this
 * is the one place that knows both shapes. A row that does not fit the port types (a half-filled target, a completed stream without its columns) is corrupt data and
 * is reported as {@link IllegalStateException}, not as a business refusal.
 */
@Component
public class OutputMapper {

    /** A new {@code PENDING} row with no stream and the first version; the charge is the reserved size. */
    public CommandOutputRow newRow(OutputId id, OutputBinding binding, Instant expiresAt, long chargeBytes) {
        String targetId = null;
        String targetRevision = null;
        if (binding.target() instanceof OutputTarget.Bound bound) {
            targetId = bound.targetId().value();
            targetRevision = bound.targetRevision().hex();
        }
        return new CommandOutputRow(id.value(), binding.executionId().value(), targetId, targetRevision, OutputState.PENDING, expiresAt, null, chargeBytes, StreamState.NONE,
            null, null, null, null, null, null, 1L);
    }

    /** The row with the stream columns of {@code stream}. */
    public CommandOutputRow withStream(CommandOutputRow row, StreamInfo stream) {
        return switch (stream) {
            case StreamInfo.NoStream none -> row.withStream(StreamState.NONE, null, null, null, null, null, null);
            case StreamInfo.OpenStream open -> row.withStream(StreamState.OPEN, open.bytes(), null, null, null, null, null);
            case StreamInfo.CompleteStream complete -> row.withStream(StreamState.COMPLETE, complete.bytes(), complete.size(), complete.sha256().hex(),
                complete.stdoutCursor(), complete.stderrCursor(), complete.truncation());
        };
    }

    /** One row per rendering; both renderings must be present, as they are for a ready output. */
    public List<CommandOutputFormatRow> formatRows(OutputId id, OutputFormats formats) {
        List<CommandOutputFormatRow> rows = new ArrayList<>();
        for (OutputFormat format : OutputFormat.values()) {
            FormatSpan span = span(formats, format);
            rows.add(new CommandOutputFormatRow(id.value(), format, span.offsetBytes(), span.sizeBytes(), span.sha256().hex()));
        }
        return rows;
    }

    /** One row per page digest of each rendering. */
    public List<CommandOutputPageRow> pageRows(OutputId id, OutputFormats formats) {
        List<CommandOutputPageRow> rows = new ArrayList<>();
        for (OutputFormat format : OutputFormat.values()) {
            List<Digest> digests = span(formats, format).pageDigests();
            for (int pageNo = 0; pageNo < digests.size(); pageNo++) {
                rows.add(new CommandOutputPageRow(id.value(), format, pageNo, digests.get(pageNo).hex()));
            }
        }
        return rows;
    }

    /** The manifest of a row; the renderings are the format rows and page rows of that output (empty before it is ready). */
    public OutputManifest toManifest(CommandOutputRow row, List<CommandOutputFormatRow> formatRows, List<CommandOutputPageRow> pageRows) {
        Map<OutputFormat, FormatSpan> spans = new EnumMap<>(OutputFormat.class);
        for (CommandOutputFormatRow formatRow : formatRows) {
            List<Digest> digests = pageRows.stream().filter(page -> page.format() == formatRow.format()).sorted(Comparator.comparingInt(CommandOutputPageRow::pageNo))
                .map(page -> new Digest(page.sha256())).toList();
            spans.put(formatRow.format(), new FormatSpan(formatRow.offsetBytes(), formatRow.sizeBytes(), new Digest(formatRow.sha256()), digests));
        }
        long size = row.sizeBytes() == null ? 0L : row.sizeBytes();
        return new OutputManifest(new OutputId(row.id()), binding(row), row.state(), row.expiresAt(), row.chargeBytes(), size, new OutputFormats(spans), stream(row),
            row.version());
    }

    private OutputBinding binding(CommandOutputRow row) {
        OutputTarget target = new OutputTarget.Unbound();
        if (row.targetId() != null || row.targetRevision() != null) {
            if (row.targetId() == null || row.targetRevision() == null) {
                throw new IllegalStateException("Output " + row.id() + " has half a target binding");
            }
            target = new OutputTarget.Bound(new TargetId(row.targetId()), TargetRevision.of(row.targetRevision()));
        }
        return new OutputBinding(new OperationId(row.executionId()), target);
    }

    private StreamInfo stream(CommandOutputRow row) {
        return switch (row.streamState()) {
            case NONE -> new StreamInfo.NoStream();
            case OPEN -> new StreamInfo.OpenStream(required(row, row.streamBytes(), "stream_bytes"));
            case COMPLETE -> new StreamInfo.CompleteStream(required(row, row.streamBytes(), "stream_bytes"), required(row, row.streamSize(), "stream_size"),
                new Digest(requiredText(row, row.streamSha256(), "stream_sha256")), required(row, row.stdoutCursor(), "stdout_cursor"),
                required(row, row.stderrCursor(), "stderr_cursor"), requiredTruncation(row));
        };
    }

    private FormatSpan span(OutputFormats formats, OutputFormat format) {
        FormatSpan span = formats.spans().get(format);
        if (span == null) {
            throw new IllegalArgumentException("A ready output has both renderings; missing " + format);
        }
        return span;
    }

    private long required(CommandOutputRow row, Long value, String column) {
        if (value == null) {
            throw new IllegalStateException("Output " + row.id() + " has no " + column + " although its stream is " + row.streamState());
        }
        return value;
    }

    private String requiredText(CommandOutputRow row, String value, String column) {
        if (value == null) {
            throw new IllegalStateException("Output " + row.id() + " has no " + column + " although its stream is " + row.streamState());
        }
        return value;
    }

    private StreamInfo.Truncation requiredTruncation(CommandOutputRow row) {
        if (row.streamTruncated() == null) {
            throw new IllegalStateException("Output " + row.id() + " has no stream_truncated although its stream is " + row.streamState());
        }
        return row.streamTruncated();
    }
}
