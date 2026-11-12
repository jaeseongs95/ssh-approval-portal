package io.github.jaeseongs95.portal.domain.operation;

import java.util.Objects;
import java.util.regex.Pattern;

/** How the remote process ended: with an exit code, by a signal, or not at all (it never started, or its end was not seen). */
public sealed interface ExitStatus permits ExitStatus.Exited, ExitStatus.Signaled, ExitStatus.NoExit {

    /** The process exited with the code. */
    record Exited(int code) implements ExitStatus {
    }

    /** The process was ended by a signal, named in upper case ({@code TERM}, {@code KILL}): 1 to 32 characters of {@code A-Z 0-9 _ -}. */
    record Signaled(String name) implements ExitStatus {

        private static final Pattern SHAPE = Pattern.compile("[A-Z0-9_-]{1,32}");

        public Signaled {
            Objects.requireNonNull(name, "name");
            if (!SHAPE.matcher(name).matches()) {
                throw new IllegalArgumentException("A signal name is 1 to 32 characters of A-Z 0-9 _ -");
            }
        }
    }

    /** There is no exit status. */
    record NoExit() implements ExitStatus {
    }
}
