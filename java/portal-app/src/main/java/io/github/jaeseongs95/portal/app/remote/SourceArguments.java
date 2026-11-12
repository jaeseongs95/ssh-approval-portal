package io.github.jaeseongs95.portal.app.remote;

import java.util.List;

/**
 * The arguments of a script run. Each is a text without a NUL character, which neither a command line nor a process argument can carry.
 *
 * @param values the arguments in order, possibly none
 */
public record SourceArguments(List<String> values) {

    public SourceArguments {
        values = List.copyOf(values);
        for (String value : values) {
            if (value.indexOf('\0') >= 0) {
                throw new IllegalArgumentException("A source argument has no NUL");
            }
        }
    }

    /** A run without arguments. */
    public static SourceArguments none() {
        return new SourceArguments(List.of());
    }
}
