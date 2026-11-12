package io.github.jaeseongs95.portal.app.output;

import java.time.Instant;
import java.util.Objects;

/**
 * The metadata of one stored output. {@code chargeBytes} is what the output counts against the budget: the reserved size until it is ready, then the real size
 * (2.x {@code charge}). The optimistic-lock version rises with every change.
 */
public record OutputManifest(OutputId id, OutputBinding binding, OutputState state, Instant expiresAt, long chargeBytes, long sizeBytes, OutputFormats formats, StreamInfo stream,
                             long version) {

    public OutputManifest {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(binding, "binding");
        Objects.requireNonNull(state, "state");
        Objects.requireNonNull(expiresAt, "expiresAt");
        Objects.requireNonNull(formats, "formats");
        Objects.requireNonNull(stream, "stream");
        if (chargeBytes < 0 || sizeBytes < 0) {
            throw new IllegalArgumentException("The charge and the size must not be negative");
        }
    }
}
