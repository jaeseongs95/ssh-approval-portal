package io.github.jaeseongs95.portal.app.execution;

import java.util.Objects;

/**
 * The JSON rendering of the output of a command: the redacted text of each stream. It is what the {@code JSON} format of a stored output holds. The two texts are each
 * redacted as a whole, once, when the rendering is made: a secret that spans two frames is still found, which a redaction of every frame could not do (2.x
 * {@code command-output.mjs:205}).
 *
 * @param stdout the redacted standard output
 * @param stderr the redacted standard error
 */
public record OutputDocument(String stdout, String stderr) {

    public OutputDocument {
        Objects.requireNonNull(stdout, "stdout");
        Objects.requireNonNull(stderr, "stderr");
    }
}
