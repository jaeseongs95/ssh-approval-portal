package io.github.jaeseongs95.portal.app.output;

import java.util.Arrays;
import java.util.Objects;

/** A piece of one stream. The payload store writes a frame as one byte of {@link StreamKind}, four bytes (big endian) of length and the data (2.x {@code .stream}). */
public record StreamFrame(StreamKind kind, byte[] data) {

    public StreamFrame {
        Objects.requireNonNull(kind, "kind");
        data = data.clone();
    }

    @Override
    public byte[] data() {
        return data.clone();
    }

    @Override
    public boolean equals(Object other) {
        return other instanceof StreamFrame frame && kind == frame.kind && Arrays.equals(data, frame.data);
    }

    @Override
    public int hashCode() {
        return 31 * kind.hashCode() + Arrays.hashCode(data);
    }

    @Override
    public String toString() {
        return "StreamFrame[kind=" + kind + ", bytes=" + data.length + "]";
    }
}
