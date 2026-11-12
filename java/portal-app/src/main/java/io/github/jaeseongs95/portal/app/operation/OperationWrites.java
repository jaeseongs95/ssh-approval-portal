package io.github.jaeseongs95.portal.app.operation;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.event.OperationEvents;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.domain.operation.Operation;

/**
 * Stores a new version of an operation and tells everyone who has to know: the event that wakes the waiters and the dispatcher, the listeners of a terminal operation,
 * and the timer of a waiting one. Every use case that changes an operation goes through here, so no change is stored without being announced. The journal checks the
 * version (compare-and-set); a lost race is its {@code OPERATION_VERSION_CONFLICT}, which the caller handles. The audit of an outcome is {@link OutcomeAudit}'s.
 */
@Component
public class OperationWrites {

    private final OperationJournal journal;
    private final OperationEvents events;
    private final TerminalNotifier terminal;
    private final ExpiryTimers timers;

    public OperationWrites(OperationJournal journal, OperationEvents events, TerminalNotifier terminal, ExpiryTimers timers) {
        this.journal = journal;
        this.events = events;
        this.terminal = terminal;
        this.timers = timers;
    }

    /** Stores {@code next} when the stored version is {@code expectedVersion}, then announces it. Returns the stored operation. */
    public Operation store(Operation next, long expectedVersion) {
        Operation stored = journal.save(next, expectedVersion);
        events.changed(stored);
        if (stored.state().isTerminal()) {
            terminal.ended(stored);
        }
        timers.arm(stored);
        return stored;
    }
}
