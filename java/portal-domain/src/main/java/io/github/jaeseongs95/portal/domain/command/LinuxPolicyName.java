package io.github.jaeseongs95.portal.domain.command;

import com.fasterxml.jackson.annotation.JsonValue;
import java.util.Objects;
import java.util.regex.Pattern;

/** A program name on a POSIX target: 1 to 80 characters of {@code A-Z a-z 0-9 _ . + -}, not starting with a punctuation mark (command-policy.mjs:14 {@code name}). */
public record LinuxPolicyName(@JsonValue String text) implements PolicyName {

    private static final Pattern SHAPE = Pattern.compile("[A-Za-z0-9_][A-Za-z0-9_.+-]{0,79}");

    public LinuxPolicyName {
        Objects.requireNonNull(text, "text");
        if (!SHAPE.matcher(text).matches()) {
            throw new IllegalArgumentException("A POSIX policy name is 1 to 80 characters of A-Z a-z 0-9 _ . + - and does not start with a punctuation mark");
        }
    }

    /** The answer of {@link CommandLineGrammar#normalize(String)} for a POSIX target: the name as written, or a refusal. */
    public static NormalizedName parse(String proposed) {
        Objects.requireNonNull(proposed, "proposed");
        return SHAPE.matcher(proposed).matches() ? new NormalizedName.Accepted(new LinuxPolicyName(proposed)) : new NormalizedName.Rejected();
    }

    @Override
    public String key() {
        return text;
    }
}
