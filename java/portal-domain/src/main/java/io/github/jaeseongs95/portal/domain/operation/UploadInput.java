package io.github.jaeseongs95.portal.domain.operation;

import io.github.jaeseongs95.portal.domain.file.FileBinding;
import io.github.jaeseongs95.portal.domain.file.FileName;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.CanonicalForm;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import java.util.Objects;

/**
 * A file the server holds (an artifact) that is to be written to a path on the target. The size and the digest are those of the stored file, so what is approved is
 * what is transferred.
 *
 * @param artifactId the stored file
 * @param remotePath where on the target it is written
 * @param fileName the file's name
 * @param sizeBytes the size, 0 to 64 MiB
 * @param sha256 the digest of the content
 * @param overwrite what to do when the remote file exists
 * @param elevation whether the write uses elevated rights
 * @param binding the target and revision the server bound the file operation to
 * @param protocol how the upload reached the server
 */
public record UploadInput(ArtifactId artifactId, RemotePath remotePath, FileName fileName, long sizeBytes, Digest sha256, OverwriteMode overwrite, Elevation elevation,
                          FileBinding binding, UploadProtocol protocol) implements OperationInput {

    /** The largest file a transfer carries: 64 MiB (2.x ports.mjs MAX_BYTES). */
    public static final long MAX_BYTES = 64L * 1024 * 1024;

    public UploadInput {
        Objects.requireNonNull(artifactId, "artifactId");
        Objects.requireNonNull(remotePath, "remotePath");
        Objects.requireNonNull(fileName, "fileName");
        Objects.requireNonNull(sha256, "sha256");
        Objects.requireNonNull(overwrite, "overwrite");
        Objects.requireNonNull(elevation, "elevation");
        Objects.requireNonNull(binding, "binding");
        Objects.requireNonNull(protocol, "protocol");
        if (sizeBytes < 0 || sizeBytes > MAX_BYTES) {
            throw new IllegalArgumentException("A file is 0 to " + MAX_BYTES + " bytes");
        }
    }

    @Override
    public OperationKind kind() {
        return OperationKind.UPLOAD;
    }

    @Override
    public CanonicalForm describeTo(CanonicalForm form) {
        CanonicalForm described = form.field("input.kind", "upload").field("upload.artifactId", artifactId.value()).field("upload.remotePath", remotePath.value())
            .field("upload.fileName", fileName.value()).field("upload.sizeBytes", sizeBytes).field("upload.sha256", sha256.hex())
            .field("upload.overwrite", overwrite.name()).field("upload.elevation", elevation.name()).field("upload.protocol", protocol.name());
        return binding.describeTo(described);
    }
}
