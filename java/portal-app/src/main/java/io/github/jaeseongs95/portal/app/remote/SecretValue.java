package io.github.jaeseongs95.portal.app.remote;

import java.util.Arrays;
import java.util.Objects;

/**
 * A secret text (a password, a passphrase, a private key) that does not appear when it is printed, logged or put in an exception message: {@link #toString()} is a
 * fixed text, and so is the text of every record that holds one. The characters are copied in and out, and {@link #reveal()} is the one way to read them; its caller
 * is the code that hands the secret to the SSH library. The value is not cleared on a garbage collection and not a defence against a memory dump.
 */
public final class SecretValue {

    private final char[] characters;

    private SecretValue(char[] characters) {
        this.characters = characters;
    }

    /** A secret of the text, which is not empty. */
    public static SecretValue of(CharSequence text) {
        Objects.requireNonNull(text, "text");
        if (text.isEmpty()) {
            throw new IllegalArgumentException("A secret is not empty");
        }
        char[] copy = new char[text.length()];
        for (int i = 0; i < copy.length; i++) {
            copy[i] = text.charAt(i);
        }
        return new SecretValue(copy);
    }

    /** A copy of the characters; the caller clears it when it is done. */
    public char[] reveal() {
        return characters.clone();
    }

    /** The number of characters. */
    public int length() {
        return characters.length;
    }

    @Override
    public boolean equals(Object other) {
        return other instanceof SecretValue secret && Arrays.equals(characters, secret.characters);
    }

    /** The length only, so the hash code tells nothing about the characters. */
    @Override
    public int hashCode() {
        return Integer.hashCode(characters.length);
    }

    @Override
    public String toString() {
        return "SecretValue[redacted]";
    }
}
