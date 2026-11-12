package io.github.jaeseongs95.portal.app.remote;

import java.time.Instant;
import java.util.Objects;

/**
 * The proof that an original file was put back after a failed replacement: the adapter read the target and found the original again. Only with it is a failed
 * replacement a plain failure; without it the result is unknown.
 *
 * @param confirmedAt when the restored original was confirmed
 */
public record RestoreEvidence(Instant confirmedAt) {

    public RestoreEvidence {
        Objects.requireNonNull(confirmedAt, "confirmedAt");
    }
}
