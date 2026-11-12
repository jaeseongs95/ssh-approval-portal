package io.github.jaeseongs95.portal.app.execution;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.file.DownloadJob;
import io.github.jaeseongs95.portal.app.file.DownloadService;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.app.remote.ExecutionTimeline;
import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchRefusedException;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.operation.DownloadInput;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationKind;

/**
 * Runs the operations of kind {@code DOWNLOAD}: it hands the stored input to {@link DownloadService}, which reads the file into a new artifact and answers the outcome the
 * operation settles from. A download only reads, so every failure is {@code FAILED} and never {@code UNKNOWN}, a lost connection included (decision D3-17, defect D-0013);
 * that decision is written once, in {@code TransferOutcomes}, and this runner adds nothing to it.
 */
@Component
public class DownloadOperationRunner implements OperationRunner {

    private final DownloadService downloads;
    private final RunTargets targets;

    public DownloadOperationRunner(DownloadService downloads, RunTargets targets) {
        this.downloads = downloads;
        this.targets = targets;
    }

    @Override
    public OperationKind kind() {
        return OperationKind.DOWNLOAD;
    }

    @Override
    public ExecutionReport run(Operation operation, ExecutionControl control) {
        if (!(operation.input() instanceof DownloadInput input)) {
            throw new IllegalArgumentException("Not a download operation: " + operation.kind());
        }
        DownloadJob job = new DownloadJob(targets.of(operation), operation.targetRevision(), input);
        try {
            return new ExecutionReport(downloads.download(job, control).outcome(), ExecutionTimeline.empty());
        } catch (RequestRefusedException e) {
            throw new DispatchRefusedException(DispatchFailure.refused(DispatchReason.UNKNOWN, DispatchStage.FILE_GUARD), e);
        }
    }
}
