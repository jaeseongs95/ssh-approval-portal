package io.github.jaeseongs95.portal.store.audit;

import java.io.Closeable;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.WritableByteChannel;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.concurrent.locks.ReentrantLock;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.audit.AuditEvent;
import io.github.jaeseongs95.portal.app.audit.AuditFailedException;
import io.github.jaeseongs95.portal.app.audit.AuditLog;
import io.github.jaeseongs95.portal.store.storage.PrivateStorages;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.json.JsonMapper;

/**
 * {@link AuditLog} as a JSON Lines file: one JSON object per line with {@code at} (ISO-8601 UTC), {@code action} (wire value), {@code id} and {@code note}
 * (2.x {@code jsonl.mjs}). A record is one write loop to the channel, which continues after a short write and fails when the channel takes no byte, and the file is
 * forced to the disk before {@link #append} returns, so the caller (an approval) is allowed only when the line is durable. Any failure is an
 * {@link AuditFailedException} with the cause. Appends are serialized so that two lines never interleave; the audit file is not read here.
 */
@Component
public final class JsonlAuditLog implements AuditLog, Closeable {

    private final AuditFile file;
    private final Clock clock;
    private final JsonMapper mapper;
    private final ReentrantLock lock = new ReentrantLock();

    /** The production constructor: the file named by the location is created if absent and appended to. */
    @Autowired
    public JsonlAuditLog(AuditFileLocation location, Clock clock, JsonMapper mapper, PrivateStorages storages) {
        this(new FileChannelAuditFile(location.file(), storages), clock, mapper);
    }

    JsonlAuditLog(AuditFile file, Clock clock, JsonMapper mapper) {
        this.file = file;
        this.clock = clock;
        this.mapper = mapper;
    }

    @Override
    public void append(AuditEvent event) {
        byte[] line = encode(event);
        lock.lock();
        try {
            write(file.channel(), ByteBuffer.wrap(line));
            file.force();
        } catch (IOException e) {
            throw new AuditFailedException("The audit record could not be written", e);
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void close() throws IOException {
        file.close();
    }

    private byte[] encode(AuditEvent event) {
        AuditLine line = new AuditLine(clock.instant().toString(), event.action(), event.operationId().value(), event.note());
        try {
            return (mapper.writeValueAsString(line) + "\n").getBytes(StandardCharsets.UTF_8);
        } catch (JacksonException e) {
            throw new AuditFailedException("The audit record could not be encoded", e);
        }
    }

    /** Writes until the buffer is empty. A channel that returns 0 bytes would loop for ever, so it is a failure (2.x refused a zero-byte write too). */
    private void write(WritableByteChannel channel, ByteBuffer bytes) throws IOException {
        while (bytes.hasRemaining()) {
            if (channel.write(bytes) <= 0) {
                throw new AuditFailedException("The audit file accepted no bytes");
            }
        }
    }
}
