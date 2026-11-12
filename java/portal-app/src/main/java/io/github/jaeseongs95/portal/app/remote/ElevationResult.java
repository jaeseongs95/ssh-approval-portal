package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.target.TargetOs;

/** The answer of an elevation check: the target allows elevated file work, refuses it, has no such thing, or could not be asked. */
public sealed interface ElevationResult permits ElevationResult.Granted, ElevationResult.Denied, ElevationResult.NotApplicable, ElevationResult.Unavailable {

    /** The probe showed that the account may elevate. */
    record Granted() implements ElevationResult {
    }

    /** The probe showed that it may not (no passwordless {@code sudo}, a connection that is not the administrator's). The file work is refused before it starts. */
    record Denied() implements ElevationResult {
    }

    /**
     * The operating system has no elevation to check.
     *
     * @param os the operating system of the target
     */
    record NotApplicable(TargetOs os) implements ElevationResult {

        public NotApplicable {
            Objects.requireNonNull(os, "os");
        }
    }

    /**
     * The probe could not be run: the connection failed, the time ran out or the owner cancelled.
     *
     * @param cause why
     */
    record Unavailable(TransferFailureCause cause) implements ElevationResult {

        public Unavailable {
            Objects.requireNonNull(cause, "cause");
        }
    }
}
