package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.path.RemotePath;

/**
 * Permission bits to set on a file of a target. The target's {@link PermissionSupport} is part of the request, so an adapter that gets {@code Unsupported} answers
 * without calling SFTP.
 *
 * @param target where the file is
 * @param path the file path on the target, in the target's syntax
 * @param mode the bits to set
 * @param support whether the target can set them
 * @param access the rights it is done with
 * @param pathPolicy the target's allowed-root rule
 * @param limits the time limit (the file size is not used)
 */
public record PermissionRequest(RemoteTarget target, RemotePath path, FileMode mode, PermissionSupport support, FileAccess access, PathPolicyBinding pathPolicy,
                                TransferLimits limits) {

    public PermissionRequest {
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(path, "path");
        Objects.requireNonNull(mode, "mode");
        Objects.requireNonNull(support, "support");
        Objects.requireNonNull(access, "access");
        Objects.requireNonNull(pathPolicy, "pathPolicy");
        Objects.requireNonNull(limits, "limits");
    }
}
