package io.github.jaeseongs95.portal.domain.capacity;

import java.util.Objects;
import java.util.regex.Pattern;

/**
 * A capacity: a whole number of at least one (a queue length, a number of simultaneous operations). 2.x accepted every safe JavaScript integer; a Java
 * {@code int} is the largest number a queue or a semaphore can use, so a larger number is rejected instead of being cut (2.x capacity.mjs:1-9).
 */
public record Capacity(int value) {

    private static final Pattern DIGITS = Pattern.compile("[1-9][0-9]*");

    public Capacity {
        if (value < 1) {
            throw new IllegalArgumentException("A capacity is at least 1");
        }
    }

    /** Reads a setting's text: plain digits, no sign, no leading zero, no blank, and a value an {@code int} holds. */
    public static Capacity parse(String text) {
        Objects.requireNonNull(text, "text");
        if (!DIGITS.matcher(text).matches()) {
            throw new IllegalArgumentException("A capacity is a whole number of at least 1 without a sign or a leading zero");
        }
        try {
            return new Capacity(Integer.parseInt(text));
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("A capacity is at most " + Integer.MAX_VALUE, e);
        }
    }
}
