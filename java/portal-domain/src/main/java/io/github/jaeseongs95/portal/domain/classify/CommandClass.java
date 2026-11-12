package io.github.jaeseongs95.portal.domain.classify;

import com.fasterxml.jackson.annotation.JsonValue;
import java.util.Arrays;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * The class of a command line, lowest to highest: {@code read-only} < {@code safe} < {@code destructive} < {@code privileged}
 * (vendor {@code CLASS_RANK}, policy/classifier.js:682-687; the configuration schema has the same four values, config/schema.js:4).
 * {@code safe} is the default for a program the classifier does not know. It is not a proof that the command is harmless.
 */
public enum CommandClass {
    READ_ONLY("read-only", 0),
    SAFE("safe", 1),
    DESTRUCTIVE("destructive", 2),
    PRIVILEGED("privileged", 3);

    private static final Map<String, CommandClass> BY_WIRE = Arrays.stream(values()).collect(Collectors.toUnmodifiableMap(CommandClass::wire, Function.identity()));

    private final String wire;
    private final int rank;

    CommandClass(String wire, int rank) {
        this.wire = wire;
        this.rank = rank;
    }

    /** The wire form: {@code read-only}, {@code safe}, {@code destructive} or {@code privileged}. */
    @JsonValue
    public String wire() {
        return wire;
    }

    /** The class for a wire value; an unknown value is an error, there is no default class. */
    public static CommandClass fromWire(String wire) {
        CommandClass found = BY_WIRE.get(wire);
        if (found == null) {
            throw new IllegalArgumentException("Unknown command class: " + wire);
        }
        return found;
    }

    /** True when this class is strictly more dangerous than {@code other}. */
    public boolean isHigherThan(CommandClass other) {
        return rank > other.rank;
    }

    /** True when this class is at least as dangerous as {@code other}. */
    public boolean isAtLeast(CommandClass other) {
        return rank >= other.rank;
    }

    /** The more dangerous of the two; this one when they are equal. */
    public CommandClass max(CommandClass other) {
        return other.rank > rank ? other : this;
    }
}
