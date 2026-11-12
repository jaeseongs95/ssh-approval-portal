package io.github.jaeseongs95.portal.app.output;

/** The stored states of an output. "Expired" is not stored: it is derived from the expiry time (2.x {@code command-output.mjs:137}). */
public enum OutputState {
    PENDING, READY, UNAVAILABLE
}
