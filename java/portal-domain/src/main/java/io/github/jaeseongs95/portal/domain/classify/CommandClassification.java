package io.github.jaeseongs95.portal.domain.classify;

import io.github.jaeseongs95.portal.domain.text.CommandText;
import java.util.Objects;
import java.util.Optional;

/**
 * The outcome of classifying one command line: its {@link CommandClass}, the program the class was decided for and, for a {@code safe} command whose first
 * program is allow-listed, the {@link ReadOnlyRejection} that kept it from {@code read-only} (vendor result {@code {binary, fullCommand, class, readOnlyRejection}},
 * policy/classifier.js:2120-2123). 2.x reads the class only; the other parts are kept because the vendor result has them and the rejection explains a
 * {@code safe} verdict.
 */
public final class CommandClassification {

    private final CommandClass commandClass;
    private final String binary;
    private final String fullCommand;
    /** Null when there is no rejection; the accessor hands out an Optional. */
    private final ReadOnlyRejection rejection;

    CommandClassification(CommandClass commandClass, String binary, String fullCommand, ReadOnlyRejection rejection) {
        this.commandClass = Objects.requireNonNull(commandClass, "commandClass");
        this.binary = Objects.requireNonNull(binary, "binary");
        this.fullCommand = Objects.requireNonNull(fullCommand, "fullCommand");
        this.rejection = rejection;
    }

    /**
     * A classification that states the class only (no program, no command text), for a target platform that does not use the vendor rules: the Windows rule of
     * 2.x ({@code target-platform.mjs:20-28}) answers {@code read-only} or {@code safe} and nothing else.
     */
    public static CommandClassification of(CommandClass commandClass) {
        return new CommandClassification(commandClass, "", "", null);
    }

    public CommandClass commandClass() {
        return commandClass;
    }

    /** The program the class was decided for: the first word without a privilege prefix, or the program run under the prefix, or the inner command that won. */
    public String binary() {
        return binary;
    }

    /** The command with the white space of both ends removed (JavaScript {@code trim}); empty for {@link #of(CommandClass)}. */
    public String fullCommand() {
        return fullCommand;
    }

    public Optional<ReadOnlyRejection> readOnlyRejection() {
        return Optional.ofNullable(rejection);
    }

    /**
     * 2.x overwrite OV-01 (validation.mjs:20): a command with a line break never stays {@code read-only}, because the classifier trims its input and so cannot
     * prove that the whole text is one read. {@code read-only} becomes {@code safe}; every other class stays (the rule raises only).
     */
    public CommandClassification forMultiline(CommandText command) {
        return raisedWhen(command.isMultiline());
    }

    /** The same rule for any string, for the cases that {@link CommandText} refuses; a line break is a CR or an LF. */
    CommandClassification forMultiline(String command) {
        return raisedWhen(command.indexOf('\n') >= 0 || command.indexOf('\r') >= 0);
    }

    private CommandClassification raisedWhen(boolean multiline) {
        if (multiline && commandClass == CommandClass.READ_ONLY) {
            return new CommandClassification(CommandClass.SAFE, binary, fullCommand, rejection);
        }
        return this;
    }

    @Override
    public boolean equals(Object other) {
        return other instanceof CommandClassification that && commandClass == that.commandClass && binary.equals(that.binary)
            && fullCommand.equals(that.fullCommand) && Objects.equals(rejection, that.rejection);
    }

    @Override
    public int hashCode() {
        return Objects.hash(commandClass, binary, fullCommand, rejection);
    }

    @Override
    public String toString() {
        return "CommandClassification[" + commandClass.wire() + ", binary=" + binary + (rejection == null ? "" : ", rejection=" + rejection) + "]";
    }
}
