package io.github.jaeseongs95.portal.app.file;

import java.util.Objects;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.operation.TerminalOperationListener;
import io.github.jaeseongs95.portal.domain.operation.CompletionEvidence;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.RecordedResult;
import io.github.jaeseongs95.portal.domain.operation.Settlement;
import io.github.jaeseongs95.portal.domain.operation.UploadInput;

/**
 * Settles the use of a staged file when its operation reaches a final state (RC-B-130 to RC-B-132): the action of the staged file ends, and a move consumes the staged file only
 * when the operation completed with the evidence that this very content was published. It is a listener of {@link TerminalOperationListener}, so the dispatcher knows nothing
 * of staged files. The evidence is the one the executor recorded with the result; an operation that ended without an executor (denied, expired, refused by a guard) has none,
 * which is a settled action that consumed nothing. An {@code UNKNOWN} operation is not final and leaves the action open (see {@link StagedFileService}).
 */
@Component
public class StagedActionSettlement implements TerminalOperationListener {

    private final StagedFileService staged;

    public StagedActionSettlement(StagedFileService staged) {
        this.staged = Objects.requireNonNull(staged, "staged");
    }

    @Override
    public void onTerminal(Operation operation) {
        if (operation.input() instanceof UploadInput) {
            staged.operationSettled(operation.id(), operation.state(), evidenceOf(operation));
        }
    }

    private static CompletionEvidence evidenceOf(Operation operation) {
        if (operation.settlement() instanceof Settlement.Settled settled && settled.result() instanceof RecordedResult.Executed executed) {
            return executed.outcome().evidence();
        }
        return new CompletionEvidence.NoEvidence();
    }
}
