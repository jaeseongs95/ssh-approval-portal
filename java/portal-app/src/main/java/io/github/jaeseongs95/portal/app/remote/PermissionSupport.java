package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

/** Whether a target can set the permission bits of a file ({@code TargetPlatform#permissionSupport}). */
public sealed interface PermissionSupport permits PermissionSupport.Supported, PermissionSupport.Unsupported {

    /** The target takes {@code chmod}. */
    record Supported() implements PermissionSupport {
    }

    /** The target cannot; the adapter does not call SFTP and answers {@link PermissionResult.Unsupported}. */
    record Unsupported(UnsupportedReason reason) implements PermissionSupport {

        public Unsupported {
            Objects.requireNonNull(reason, "reason");
        }
    }
}
