package io.github.jaeseongs95.portal.app.execution;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;

/** The answer to the reservation of the output of a command: the output is open, or the reservation was refused and the command must not start. */
public sealed interface OutputOpening permits OutputOpening.Opened, OutputOpening.Refused {

    /** The reservation is made; the command's output goes to it. */
    record Opened(OpenOutput output) implements OutputOpening {

        public Opened {
            Objects.requireNonNull(output, "output");
        }
    }

    /**
     * The reservation was refused: the output budget, the number of outputs, the size of one output or the disk. Nothing was sent to the target.
     *
     * @param failure the diagnosis, at the output reservation step
     */
    record Refused(ExecutionFailure failure) implements OutputOpening {

        public Refused {
            Objects.requireNonNull(failure, "failure");
        }
    }
}
