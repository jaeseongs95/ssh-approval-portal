package io.github.jaeseongs95.portal.app.output;

import java.util.Set;

import io.github.jaeseongs95.portal.app.storage.DiskSpace;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.domain.id.Digest;

/**
 * The bytes of the command outputs, in files (design 8.5). Every method does file I/O, so it is called outside a transaction (Principles 4.4). A payload is first a
 * {@code .stream} spool of frames, then the two renderings of a finished output (JSON and text) one after the other in a {@code .out} file.
 */
public interface OutputPayloadStore {

    /** Appends a frame to the spool of the output and returns how many bytes the spool holds. */
    long append(OutputId id, StreamFrame frame);

    /** Writes the finished renderings, returns their spans and removes the spool. */
    OutputFormats finish(OutputId id, byte[] json, byte[] text);

    PayloadRead openFormat(OutputId id, OutputFormat format, FormatSpan span);

    /**
     * Opens the spool of an output that is still being captured: the bytes of the {@code .stream} file as they are stored (the frames with their headers), read from the
     * start. The caller closes it. An output without a spool (finished, deleted, never written) throws {@code RequestRefusedException(OUTPUT_CAPTURE_FAILED)}. The
     * import of a stream into an artifact reads it here and compares what it hashed with {@link #streamDigest} (RC-A-182, RC-A-183).
     */
    PayloadRead openStream(OutputId id);

    /** The SHA-256 of the spool exactly as {@link #openStream} delivers it; read from the file, so a spool that was changed on the disk gives another digest. */
    Digest streamDigest(OutputId id);

    void delete(OutputId id);

    /** The bytes the files of this output hold now. */
    long retainedBytes(OutputId id);

    /** Moves a payload that has no metadata to the quarantine folder (2.x orphan handling). */
    void quarantine(OutputId id);

    Set<OutputId> stored();

    DiskSpace usable();
}
