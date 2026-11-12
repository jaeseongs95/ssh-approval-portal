package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;
import java.util.regex.Pattern;

/**
 * A command line the portal itself fixes and sends to a target: the probe of an elevation check, a step of an agent CLI installation. It is not made from anything a
 * caller wrote, so it holds no secret and no user input; the list of all of them is the one published in {@code docs/external-programs}, which a test compares with
 * what the adapter sends. It is an external program on the target, not on this server, and that is why Java cannot replace it (the target has no JVM).
 *
 * @param label a short lower-case name of the step, 1 to 32 characters of {@code a-z 0-9 -} starting with a letter
 * @param commandLine the line sent in the {@code exec} request, not blank and without NUL
 */
public record FixedRemoteCommand(String label, String commandLine) {

    private static final Pattern LABEL = Pattern.compile("[a-z][a-z0-9-]{0,31}");

    public FixedRemoteCommand {
        Objects.requireNonNull(label, "label");
        Objects.requireNonNull(commandLine, "commandLine");
        if (!LABEL.matcher(label).matches()) {
            throw new IllegalArgumentException("A fixed command label is 1 to 32 characters of a-z 0-9 - and starts with a letter");
        }
        if (commandLine.isBlank() || commandLine.indexOf('\0') >= 0) {
            throw new IllegalArgumentException("A fixed command line is not blank and has no NUL");
        }
    }
}
