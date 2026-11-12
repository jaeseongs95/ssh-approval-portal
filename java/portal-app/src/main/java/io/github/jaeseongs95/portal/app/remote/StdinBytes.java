package io.github.jaeseongs95.portal.app.remote;

import java.util.Arrays;
import java.util.Objects;

/**
 * The bytes written to the standard input of a remote command, before its input is closed. The array is copied in and out, so the value cannot be changed from
 * outside. It may hold the source of a script, so {@link #toString()} shows the length only.
 */
public record StdinBytes(byte[] bytes) {

    public StdinBytes {
        Objects.requireNonNull(bytes, "bytes");
        bytes = bytes.clone();
    }

    /** No input: the standard input is closed at once. */
    public static StdinBytes none() {
        return new StdinBytes(new byte[0]);
    }

    @Override
    public byte[] bytes() {
        return bytes.clone();
    }

    public int length() {
        return bytes.length;
    }

    @Override
    public boolean equals(Object other) {
        return other instanceof StdinBytes stdin && Arrays.equals(bytes, stdin.bytes);
    }

    @Override
    public int hashCode() {
        return Arrays.hashCode(bytes);
    }

    @Override
    public String toString() {
        return "StdinBytes[length=" + bytes.length + "]";
    }
}
