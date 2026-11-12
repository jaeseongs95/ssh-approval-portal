package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

/**
 * A command in the form the target's shell takes it: the line to pass to {@code exec} and the bytes for its standard input. The target platform makes it
 * ({@code TargetPlatform#prepareCommand}, {@code #prepareSource}), so the executor sends it as it is and knows nothing of the shell. The line and the input can carry
 * what the owner approved, so {@link #toString()} shows only the kind and the sizes.
 *
 * @param commandLine the line sent in the {@code exec} request, not empty and without NUL
 * @param stdin the bytes written to the standard input
 * @param kind what the command was made from
 */
public record PreparedCommand(String commandLine, StdinBytes stdin, CommandKind kind) {

    public PreparedCommand {
        Objects.requireNonNull(commandLine, "commandLine");
        Objects.requireNonNull(stdin, "stdin");
        Objects.requireNonNull(kind, "kind");
        if (commandLine.isEmpty() || commandLine.indexOf('\0') >= 0) {
            throw new IllegalArgumentException("A prepared command line is not empty and has no NUL");
        }
    }

    @Override
    public String toString() {
        return "PreparedCommand[kind=" + kind + ", commandLineChars=" + commandLine.length() + ", stdinBytes=" + stdin.length() + "]";
    }
}
