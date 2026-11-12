package io.github.jaeseongs95.portal.app.execution;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.file.FilePermission;
import io.github.jaeseongs95.portal.app.file.UploadJob;
import io.github.jaeseongs95.portal.app.file.UploadService;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.app.remote.ExecutionTimeline;
import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchRefusedException;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationKind;
import io.github.jaeseongs95.portal.domain.operation.UploadInput;

/**
 * Runs the operations of kind {@code UPLOAD}: it hands the stored input to {@link UploadService}, which publishes the file and answers the outcome the operation settles
 * from (only {@code Published} completes it, defect D-0035). The runner adds nothing to that decision. A refusal of the use case before the first write (the target lacks a
 * capability the request needs) is a refusal before dispatch, never an unknown result. The phases of the connection are inside the adapter and do not reach the use
 * case, so the report carries no timeline.
 */
@Component
public class UploadOperationRunner implements OperationRunner {

    private final UploadService uploads;
    private final RunTargets targets;

    public UploadOperationRunner(UploadService uploads, RunTargets targets) {
        this.uploads = uploads;
        this.targets = targets;
    }

    @Override
    public OperationKind kind() {
        return OperationKind.UPLOAD;
    }

    @Override
    public ExecutionReport run(Operation operation, ExecutionControl control) {
        if (!(operation.input() instanceof UploadInput input)) {
            throw new IllegalArgumentException("Not an upload operation: " + operation.kind());
        }
        UploadJob job = new UploadJob(targets.of(operation), operation.targetRevision(), input, new FilePermission.PlatformDefault());
        try {
            return new ExecutionReport(uploads.upload(job, control), ExecutionTimeline.empty());
        } catch (RequestRefusedException e) {
            throw new DispatchRefusedException(DispatchFailure.refused(DispatchReason.UNKNOWN, DispatchStage.FILE_GUARD), e);
        }
    }
}
