package io.github.jaeseongs95.portal.app.storage;

import java.io.Closeable;
import java.io.IOException;
import java.nio.channels.ReadableByteChannel;
import java.util.Objects;

/** An open read of stored bytes: the channel and the number of bytes it will deliver. The caller closes it (try-with-resources). */
public record PayloadRead(ReadableByteChannel channel, long size) implements Closeable {

    public PayloadRead {
        Objects.requireNonNull(channel, "channel");
        if (size < 0) {
            throw new IllegalArgumentException("size must not be negative: " + size);
        }
    }

    @Override
    public void close() throws IOException {
        channel.close();
    }
}
