package io.github.jaeseongs95.portal.app.execution;

import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationKind;

/**
 * Runs the operations of one kind. The dispatcher asks the runner of {@link #kind()}, so a new kind is a new bean and no code of the dispatcher changes (open for
 * extension): the command runner is here, the file and agent CLI runners belong to the file and agent CLI services.
 *
 * <p>A runner answers with an {@link ExecutionReport} for everything that happens once the work is under way. Before the first thing that changes the target it calls
 * {@link ExecutionControl#guard()}; a refusal of the guard, or any refusal of the runner itself before it sent something, is a {@code DispatchRefusedException}. A runner
 * never sends a request twice.
 */
public interface OperationRunner {

    /** The kind of operation this runner runs; the dispatcher keys the runners by it, and two runners for one kind stop the start. */
    OperationKind kind();

    ExecutionReport run(Operation operation, ExecutionControl control);
}
