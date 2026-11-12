package io.github.jaeseongs95.portal.store.output;

import java.time.Instant;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

import io.github.jaeseongs95.portal.app.output.OutputState;
import io.github.jaeseongs95.portal.app.output.StreamInfo;

/**
 * Table {@code command_output}: the manifest of one output (2.x {@code outputs}). The nullable columns are nullable components of this persistence record, which no
 * other layer sees: {@code targetId}/{@code targetRevision} (an output of an execution without a target), {@code sizeBytes} (until it is ready) and the stream
 * columns (set from the stream state on). The row is immutable; the {@code with...} methods answer a changed copy for {@code JdbcAggregateOperations#update}.
 */
@Table("command_output")
public record CommandOutputRow(@Id String id, String executionId, String targetId, String targetRevision, OutputState state, Instant expiresAt, Long sizeBytes,
                               long chargeBytes, StreamState streamState, Long streamBytes, Long streamSize, String streamSha256, Long stdoutCursor, Long stderrCursor,
                               StreamInfo.Truncation streamTruncated, long version) {

    public CommandOutputRow withVersion(long next) {
        return new CommandOutputRow(id, executionId, targetId, targetRevision, state, expiresAt, sizeBytes, chargeBytes, streamState, streamBytes, streamSize, streamSha256,
            stdoutCursor, stderrCursor, streamTruncated, next);
    }

    public CommandOutputRow withChargeBytes(long next) {
        return new CommandOutputRow(id, executionId, targetId, targetRevision, state, expiresAt, sizeBytes, next, streamState, streamBytes, streamSize, streamSha256,
            stdoutCursor, stderrCursor, streamTruncated, version);
    }

    /** The row after {@code PENDING} to {@code UNAVAILABLE} (or a new look at an {@code UNAVAILABLE} one): the given expiry and the charge of the bytes held. */
    public CommandOutputRow withUnavailable(Instant nextExpiry, long nextCharge) {
        return new CommandOutputRow(id, executionId, targetId, targetRevision, OutputState.UNAVAILABLE, nextExpiry, sizeBytes, nextCharge, streamState, streamBytes,
            streamSize, streamSha256, stdoutCursor, stderrCursor, streamTruncated, version);
    }

    /** The row after {@code PENDING} to {@code READY}: the real size, which is also the charge. */
    public CommandOutputRow withReady(long size) {
        return new CommandOutputRow(id, executionId, targetId, targetRevision, OutputState.READY, expiresAt, size, size, streamState, streamBytes, streamSize,
            streamSha256, stdoutCursor, stderrCursor, streamTruncated, version);
    }

    public CommandOutputRow withStream(StreamState nextState, Long bytes, Long size, String sha256, Long stdout, Long stderr, StreamInfo.Truncation truncation) {
        return new CommandOutputRow(id, executionId, targetId, targetRevision, state, expiresAt, sizeBytes, chargeBytes, nextState, bytes, size, sha256, stdout, stderr,
            truncation, version);
    }
}
