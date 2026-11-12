package io.github.jaeseongs95.portal.app.storage;

/** The result of an append: how many bytes the file holds after the append, all of them forced to disk. */
public record PayloadWrite(long storedBytes) {

    public PayloadWrite {
        if (storedBytes < 0) {
            throw new IllegalArgumentException("storedBytes must not be negative: " + storedBytes);
        }
    }
}
