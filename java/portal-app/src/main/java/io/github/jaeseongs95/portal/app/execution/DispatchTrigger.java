package io.github.jaeseongs95.portal.app.execution;

import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

import io.github.jaeseongs95.portal.app.event.OperationChanged;
import io.github.jaeseongs95.portal.domain.operation.OperationState;

/**
 * The only thing that wakes the dispatcher: an operation was queued (there is something to claim) or reached a terminal state (a slot or a fence is free). It runs after
 * the commit that wrote the change, so the dispatcher reads what was written. Nothing polls (stage 3 design 3.2, D3).
 */
@Component
public class DispatchTrigger {

    private final ExecutionDispatcher dispatcher;

    public DispatchTrigger(ExecutionDispatcher dispatcher) {
        this.dispatcher = dispatcher;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void changed(OperationChanged event) {
        if (event.state() == OperationState.QUEUED || event.state().isTerminal()) {
            dispatcher.wake();
        }
    }
}
