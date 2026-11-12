package io.github.jaeseongs95.portal.store.output;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.Channels;
import java.nio.channels.FileChannel;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.output.FormatSpan;
import io.github.jaeseongs95.portal.app.output.OutputFormat;
import io.github.jaeseongs95.portal.app.output.OutputFormats;
import io.github.jaeseongs95.portal.app.output.OutputId;
import io.github.jaeseongs95.portal.app.output.OutputPayloadStore;
import io.github.jaeseongs95.portal.app.output.StreamFrame;
import io.github.jaeseongs95.portal.app.output.StreamKind;
import io.github.jaeseongs95.portal.app.storage.DiskSpace;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.domain.contract.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.store.output.OutputFiles.PayloadKind;

/**
 * The bytes of the command outputs, in the files of the output folder (design 8.5; 2.x {@code command-output.mjs}). An output has up to three files:
 * <ul>
 * <li>{@code <id>.stream}: the spool of the raw stdout/stderr frames, each one byte of {@link StreamKind} (0 stdout, 1 stderr), four bytes of length (big endian)
 * and the data. Every append is forced to disk before it returns, so the bytes are durable before the manifest says so. The spool never grows beyond
 * {@link OutputLimits#maxOutputBytes()}: a frame is cut to what still fits and, when nothing fits, not written (2.x truncation); the caller sees the loss as the
 * difference between the bytes it sent and the growth of the returned size.</li>
 * <li>{@code <id>.part}: the temporary file of {@code finish}.</li>
 * <li>{@code <id>.out}: the JSON rendering followed by the text rendering. {@code finish} writes the {@code .part} file, forces it, and renames it to {@code .out} in
 * one step, so a reader sees either no {@code .out} or the whole one; it then removes the spool. A finished output accepts no more frames.</li>
 * </ul>
 * Every method does file I/O and so is called outside a transaction (Principles 4.4). A read verifies the bytes it returns: the SHA-256 of each 16 KiB page and of
 * the whole rendering must match the span the manifest holds, so a damaged file is refused instead of served.
 */
@Component
public class FileOutputPayloadStore implements OutputPayloadStore {

    /** The size of one page whose digest the manifest keeps (2.x {@code OUTPUT_PAGE_BYTES}). */
    public static final int PAGE_BYTES = 16 * 1024;
    /** One byte of kind and four bytes of length in front of the data of a frame. */
    public static final int FRAME_HEADER_BYTES = 5;

    private static final Logger LOG = LoggerFactory.getLogger(FileOutputPayloadStore.class);
    private static final byte STDOUT_CODE = 0;
    private static final byte STDERR_CODE = 1;

    private final OutputFiles files;
    private final Digester digester;
    private final OutputLimits limits;

    public FileOutputPayloadStore(OutputFiles files, Digester digester, OutputLimits limits) {
        this.files = Objects.requireNonNull(files, "files");
        this.digester = Objects.requireNonNull(digester, "digester");
        this.limits = Objects.requireNonNull(limits, "limits");
    }

    @Override
    public long append(OutputId id, StreamFrame frame) {
        if (files.exists(files.path(id, PayloadKind.OUT))) {
            // The output is finished: its spool was removed and must not be started again (2.x "Output stream closed").
            throw new RequestRefusedException(ExecutionErrorCode.OUTPUT_CAPTURE_FAILED);
        }
        byte[] data = frame.data();
        try (FileChannel spool = files.openAppend(files.path(id, PayloadKind.STREAM))) {
            long size = spool.size();
            int room = (int) Math.max(0L, Math.min(data.length, limits.maxOutputBytes() - size - FRAME_HEADER_BYTES));
            if (room == 0) {
                return size;
            }
            ByteBuffer bytes = ByteBuffer.allocate(FRAME_HEADER_BYTES + room);
            bytes.put(code(frame.kind())).putInt(room).put(data, 0, room).flip();
            while (bytes.hasRemaining()) {
                spool.write(bytes);
            }
            spool.force(true);
            return spool.size();
        } catch (IOException e) {
            throw new RequestRefusedException(ExecutionErrorCode.OUTPUT_CAPTURE_FAILED, e);
        }
    }

    @Override
    public OutputFormats finish(OutputId id, byte[] json, byte[] text) {
        long total = (long) json.length + text.length;
        if (total > limits.maxOutputBytes()) {
            // 2.x "Output snapshot exceeds storage reservation": nothing is written, so the reservation is released without bytes to account for.
            throw new RequestRefusedException(ExecutionErrorCode.OUTPUT_CAPACITY);
        }
        Path out = files.path(id, PayloadKind.OUT);
        if (files.exists(out)) {
            throw new RequestRefusedException(ExecutionErrorCode.OUTPUT_CAPTURE_FAILED);
        }
        Map<OutputFormat, FormatSpan> spans = new EnumMap<>(OutputFormat.class);
        spans.put(OutputFormat.JSON, span(0L, json));
        spans.put(OutputFormat.TEXT, span(json.length, text));
        Path part = files.path(id, PayloadKind.PART);
        try (FileChannel channel = files.openFresh(part)) {
            write(channel, json);
            write(channel, text);
            channel.force(true);
        } catch (IOException e) {
            throw new RequestRefusedException(ExecutionErrorCode.OUTPUT_CAPTURE_FAILED, e);
        }
        files.moveIntoPlace(part, out);
        removeSpool(id);
        return new OutputFormats(spans);
    }

    @Override
    public PayloadRead openFormat(OutputId id, OutputFormat format, FormatSpan span) {
        if (span.sizeBytes() > limits.maxOutputBytes()) {
            throw new RequestRefusedException(ExecutionErrorCode.OUTPUT_CAPTURE_FAILED);
        }
        int size = (int) span.sizeBytes();
        byte[] bytes = new byte[size];
        try (FileChannel out = files.openRead(files.path(id, PayloadKind.OUT))) {
            if (span.offsetBytes() + size > out.size()) {
                throw damaged(id, format, "the file is shorter than its span");
            }
            out.position(span.offsetBytes());
            ByteBuffer buffer = ByteBuffer.wrap(bytes);
            while (buffer.hasRemaining()) {
                if (out.read(buffer) < 0) {
                    throw damaged(id, format, "the file ended inside its span");
                }
            }
        } catch (IOException e) {
            throw new RequestRefusedException(ExecutionErrorCode.OUTPUT_CAPTURE_FAILED, e);
        }
        verify(id, format, span, bytes);
        return new PayloadRead(Channels.newChannel(new ByteArrayInputStream(bytes)), size);
    }

    @Override
    public void delete(OutputId id) {
        for (PayloadKind kind : PayloadKind.values()) {
            files.delete(files.path(id, kind));
        }
    }

    @Override
    public long retainedBytes(OutputId id) {
        long bytes = 0L;
        for (PayloadKind kind : PayloadKind.values()) {
            Path file = files.path(id, kind);
            if (files.exists(file)) {
                bytes += files.sizeOf(file);
            }
        }
        return bytes;
    }

    @Override
    public void quarantine(OutputId id) {
        for (PayloadKind kind : PayloadKind.values()) {
            Path file = files.path(id, kind);
            if (files.exists(file)) {
                files.quarantine(file);
            }
        }
    }

    @Override
    public Set<OutputId> stored() {
        return files.storedIds();
    }

    @Override
    public DiskSpace usable() {
        return new DiskSpace(files.usableBytes());
    }

    private FormatSpan span(long offset, byte[] bytes) {
        List<Digest> pages = new ArrayList<>();
        for (int from = 0; from < bytes.length; from += PAGE_BYTES) {
            pages.add(digester.digest(Arrays.copyOfRange(bytes, from, Math.min(bytes.length, from + PAGE_BYTES))));
        }
        return new FormatSpan(offset, bytes.length, digester.digest(bytes), pages);
    }

    private void write(FileChannel channel, byte[] bytes) throws IOException {
        ByteBuffer buffer = ByteBuffer.wrap(bytes);
        while (buffer.hasRemaining()) {
            channel.write(buffer);
        }
    }

    private void verify(OutputId id, OutputFormat format, FormatSpan span, byte[] bytes) {
        int pages = (bytes.length + PAGE_BYTES - 1) / PAGE_BYTES;
        if (span.pageDigests().size() != pages) {
            throw damaged(id, format, "the span has " + span.pageDigests().size() + " page digests for " + pages + " pages");
        }
        for (int page = 0; page < pages; page++) {
            int from = page * PAGE_BYTES;
            if (!span.pageDigests().get(page).equals(digester.digest(Arrays.copyOfRange(bytes, from, Math.min(bytes.length, from + PAGE_BYTES))))) {
                throw damaged(id, format, "page " + page + " does not match its digest");
            }
        }
        if (!span.sha256().equals(digester.digest(bytes))) {
            throw damaged(id, format, "the rendering does not match its digest");
        }
    }

    /** The spool of a finished output is not needed any more; a spool that cannot be removed is left for the next delete or the start-up check. */
    private void removeSpool(OutputId id) {
        try {
            files.delete(files.path(id, PayloadKind.STREAM));
        } catch (RequestRefusedException e) {
            LOG.warn("The spool of the finished output {} could not be removed", id.value(), e);
        }
    }

    private RequestRefusedException damaged(OutputId id, OutputFormat format, String reason) {
        LOG.warn("The {} rendering of the output {} failed verification: {}", format, id.value(), reason);
        return new RequestRefusedException(ExecutionErrorCode.OUTPUT_CAPTURE_FAILED);
    }

    private byte code(StreamKind kind) {
        return switch (kind) {
            case STDOUT -> STDOUT_CODE;
            case STDERR -> STDERR_CODE;
        };
    }
}
