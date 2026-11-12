package io.github.jaeseongs95.portal.domain.operation;

/** The time limit that ended an execution, in milliseconds, when one did (the 60 second limit of defect D-0010 is reported here). */
public sealed interface TimeoutMs permits TimeoutMs.None, TimeoutMs.After {

    /** No time limit ended the execution. */
    record None() implements TimeoutMs {
    }

    /** The execution ended at a limit of this many milliseconds, a positive number. */
    record After(long millis) implements TimeoutMs {

        public After {
            if (millis < 1) {
                throw new IllegalArgumentException("A time limit is at least 1 millisecond");
            }
        }
    }
}
