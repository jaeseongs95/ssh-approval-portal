package io.github.jaeseongs95.portal.app.output;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.Digest;

/** The raw stdout/stderr stream of an execution as it is spooled (2.x {@code stream{bytes, size, sha256, stdoutCursor, stderrCursor, truncated, complete}}). */
public sealed interface StreamInfo permits StreamInfo.NoStream, StreamInfo.OpenStream, StreamInfo.CompleteStream {

    /** Nothing was spooled. */
    record NoStream() implements StreamInfo {
    }

    /** Spooling is going on; this many bytes are on disk. */
    record OpenStream(long bytes) implements StreamInfo {

        public OpenStream {
            if (bytes < 0) {
                throw new IllegalArgumentException("bytes must not be negative: " + bytes);
            }
        }
    }

    /** Spooling ended. */
    record CompleteStream(long bytes, long size, Digest sha256, long stdoutCursor, long stderrCursor, Truncation truncation) implements StreamInfo {

        public CompleteStream {
            Objects.requireNonNull(sha256, "sha256");
            Objects.requireNonNull(truncation, "truncation");
            if (bytes < 0 || size < 0 || stdoutCursor < 0 || stderrCursor < 0) {
                throw new IllegalArgumentException("A stream count must not be negative");
            }
        }
    }

    /** Whether the retained bytes are all of what the process wrote. */
    enum Truncation {
        TRUNCATED, COMPLETE
    }
}
