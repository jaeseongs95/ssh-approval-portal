package io.github.jaeseongs95.portal.app.maintenance;

import java.nio.charset.StandardCharsets;
import java.util.Objects;

/** The text of the preservation baseline taken when maintenance starts: UTF-8, at most 4 MiB (2.x {@code maintenance-state.mjs:26-31}). */
public record PreservationBaseline(String text) {

    public static final int MAX_BYTES = 4 * 1024 * 1024;

    public PreservationBaseline {
        Objects.requireNonNull(text, "text");
        if (text.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) {
            throw new IllegalArgumentException("A baseline is at most " + MAX_BYTES + " bytes");
        }
    }
}
