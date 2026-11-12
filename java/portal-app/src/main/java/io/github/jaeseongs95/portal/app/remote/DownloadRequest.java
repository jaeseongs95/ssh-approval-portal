package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.path.RemotePath;

/**
 * One file to read from a target. The adapter reads it directly and creates nothing on the target.
 *
 * @param target where it is
 * @param path the file path on the target, in the target's syntax
 * @param access the rights it is read with
 * @param pathPolicy the target's allowed-root rule
 * @param limits the time limit and the largest file; a larger file is {@link DownloadResult.TooLarge}
 */
public record DownloadRequest(RemoteTarget target, RemotePath path, FileAccess access, PathPolicyBinding pathPolicy, TransferLimits limits) {

    public DownloadRequest {
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(path, "path");
        Objects.requireNonNull(access, "access");
        Objects.requireNonNull(pathPolicy, "pathPolicy");
        Objects.requireNonNull(limits, "limits");
    }
}
