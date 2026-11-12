package io.github.jaeseongs95.portal.app.file;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.operation.DownloadInput;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/** One approved download that the dispatcher hands over to run: the stored input, the target as configured now and the revision the operation was approved for. */
public record DownloadJob(ResolvedTarget target, TargetRevision approvedRevision, DownloadInput input) {

    public DownloadJob {
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(approvedRevision, "approvedRevision");
        Objects.requireNonNull(input, "input");
    }
}
