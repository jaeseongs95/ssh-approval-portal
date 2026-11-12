package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.operation.UploadInput;
import io.github.jaeseongs95.portal.domain.path.RemotePath;

/**
 * One file to publish at a path on a target. The size and the digest are those of the stored artifact, so what the owner approved is what is written; the adapter
 * counts and hashes the bytes it reads from the {@link PayloadSource} and refuses a file that is not what is announced.
 *
 * @param target where it goes
 * @param path the file path on the target, in the target's syntax
 * @param sizeBytes the announced size, 0 to {@link UploadInput#MAX_BYTES}
 * @param sha256 the announced digest
 * @param overwrite what to do when the file exists
 * @param access the rights it is written with
 * @param pathPolicy the target's allowed-root rule
 * @param limits the time limit and the largest file
 */
public record UploadRequest(RemoteTarget target, RemotePath path, long sizeBytes, Digest sha256, OverwriteMode overwrite, FileAccess access, PathPolicyBinding pathPolicy,
                            TransferLimits limits) {

    public UploadRequest {
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(path, "path");
        Objects.requireNonNull(sha256, "sha256");
        Objects.requireNonNull(overwrite, "overwrite");
        Objects.requireNonNull(access, "access");
        Objects.requireNonNull(pathPolicy, "pathPolicy");
        Objects.requireNonNull(limits, "limits");
        if (sizeBytes < 0 || sizeBytes > UploadInput.MAX_BYTES) {
            throw new IllegalArgumentException("A file is 0 to " + UploadInput.MAX_BYTES + " bytes");
        }
    }
}
