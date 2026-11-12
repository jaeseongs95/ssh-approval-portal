package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

/**
 * What a sink answers to a piece of bytes: it took them, or it failed and says why. A failure does not stop the remote work: the adapter keeps emptying the channel
 * and drops what it reads, so the channel is released and the next request on the connection is not blocked (defect D-0040); the result then reports a capture that
 * failed and an output that is partial.
 */
public sealed interface SinkResult permits SinkResult.Accepted, SinkResult.Failed {

    /** The bytes were taken. */
    record Accepted() implements SinkResult {
    }

    /** The bytes were not taken; the cause is the sink's own exception, kept for the log of the use case. */
    record Failed(Throwable cause) implements SinkResult {

        public Failed {
            Objects.requireNonNull(cause, "cause");
        }
    }
}
