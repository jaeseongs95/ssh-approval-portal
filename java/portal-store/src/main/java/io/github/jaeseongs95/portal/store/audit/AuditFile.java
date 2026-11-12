package io.github.jaeseongs95.portal.store.audit;

import java.io.Closeable;
import java.io.IOException;
import java.nio.channels.WritableByteChannel;

/**
 * The seam between {@link JsonlAuditLog} and the file: the channel the bytes are written to and the flush to the disk. The production implementation is
 * {@link FileChannelAuditFile}; a test substitutes a channel that writes a few bytes at a time or none at all (RC-A-623, which in 2.x injected a write callback).
 */
interface AuditFile extends Closeable {

    /** The channel to write to. A write may take fewer bytes than offered; the caller loops until the buffer is empty. */
    WritableByteChannel channel();

    /** Forces the written bytes and the file metadata to the storage device ({@code FileChannel#force(true)}). */
    void force() throws IOException;
}
