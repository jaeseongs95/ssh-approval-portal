package io.github.jaeseongs95.portal.domain.operation;

import java.util.Objects;

/** What the portal received and kept of one output stream (2.x public-contract.mjs:23), or that the stream was not captured at all. */
public sealed interface StreamCapture permits StreamCapture.NotCaptured, StreamCapture.Captured {

    /** The stream was not captured (the execution never started, or it has no such stream). */
    record NotCaptured() implements StreamCapture {
    }

    /** The stream was captured: bytes received, bytes kept, the byte position a reader continues from, and whether it was cut. */
    record Captured(long receivedBytes, long retainedBytes, long cursor, Truncation truncation) implements StreamCapture {

        public Captured {
            Objects.requireNonNull(truncation, "truncation");
            if (receivedBytes < 0 || retainedBytes < 0 || cursor < 0) {
                throw new IllegalArgumentException("A byte count is not negative");
            }
        }
    }
}
