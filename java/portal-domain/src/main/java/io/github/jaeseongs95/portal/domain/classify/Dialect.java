package io.github.jaeseongs95.portal.domain.classify;

/**
 * How a backslash outside quotes is read when a command is split into words (vendor {@code dialect}). A command without a backslash is read as
 * {@link #POSIX} only; one with a backslash is read both ways and the higher class wins (CL-A01, policy/classifier.js:2074-2085).
 */
enum Dialect {
    /** A backslash outside quotes escapes the next character and disappears. */
    POSIX,
    /** A backslash is an ordinary character. */
    WINDOWS;

    boolean backslashEscapes() {
        return this == POSIX;
    }
}
