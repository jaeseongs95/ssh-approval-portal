package io.github.jaeseongs95.portal.app.file;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.operation.UploadInput;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/**
 * One approved upload that the dispatcher hands over to run: the stored input of the operation, the target as it is configured now, the revision the operation was
 * approved for (the adapter's {@code DispatchGuard} compares it with the current one before it writes), and the permission the request asked for.
 */
public record UploadJob(ResolvedTarget target, TargetRevision approvedRevision, UploadInput input, FilePermission permission) {

    public UploadJob {
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(approvedRevision, "approvedRevision");
        Objects.requireNonNull(input, "input");
        Objects.requireNonNull(permission, "permission");
    }
}
