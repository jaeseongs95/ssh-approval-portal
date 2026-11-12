package io.github.jaeseongs95.portal.app.remote;

import java.time.Instant;
import java.util.Objects;

/**
 * One phase and the instant the adapter noted it.
 *
 * @param phase the phase that was reached
 * @param at the instant, read from the injected clock
 */
public record PhaseMark(ExecutionPhase phase, Instant at) {

    public PhaseMark {
        Objects.requireNonNull(phase, "phase");
        Objects.requireNonNull(at, "at");
    }
}
