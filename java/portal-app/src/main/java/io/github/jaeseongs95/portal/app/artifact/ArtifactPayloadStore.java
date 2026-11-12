package io.github.jaeseongs95.portal.app.artifact;

import java.util.Set;

import io.github.jaeseongs95.portal.app.storage.DiskSpace;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.app.storage.PayloadWrite;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;

/**
 * The bytes of the artifacts, in files (design 8.5: a 64 MiB body is not put in a BLOB, whose streaming differs between database systems). Every method does file
 * I/O, so it must be called <em>outside</em> a transaction (Principles 4.4); the port is separate from {@link ArtifactRegistry} for that reason and because the
 * storage (disk, object store) is an axis of change of its own. A failure is a {@code RequestRefusedException} with the artifact code that names it.
 */
public interface ArtifactPayloadStore {

    /** Appends at {@code offset} (which must be the current length) and forces the bytes to disk before it returns. */
    PayloadWrite append(ArtifactId id, long offset, byte[] data);

    /** Cuts the file back to {@code length}: the start-up check removes a byte tail that the metadata never acknowledged. */
    void truncate(ArtifactId id, long length);

    long length(ArtifactId id);

    PayloadRead open(ArtifactId id);

    void delete(ArtifactId id);

    /** Moves a file that has no metadata to the quarantine folder instead of deleting it (2.x {@code #quarantine}). */
    void quarantine(ArtifactId id);

    /** The ids of every payload file in the store, for the start-up comparison with the metadata. */
    Set<ArtifactId> stored();

    DiskSpace usable();
}
