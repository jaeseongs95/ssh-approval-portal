package io.github.jaeseongs95.portal.app.operation;

import java.time.Clock;
import java.time.Instant;
import java.util.Optional;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.event.OperationEvents;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.domain.error.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.operation.Operation;

/**
 * Expires an operation whose approval deadline has passed before it was dispatched (2.x: no reaper, the deadline wakes the waiters, cases A-146, A-147, B-196). It
 * is called by the timer of {@link ExpiryTimers}, by the dispatcher for the queued operations the scheduler names, and by anything that finds an operation late. It is
 * safe to call at any time: an operation that is not waiting, or not yet late, is left alone.
 */
@Component
public class OperationExpiry {

    private final OperationJournal journal;
    private final OperationEvents events;
    private final TerminalNotifier terminal;
    private final OutcomeAudit outcomes;
    private final Clock clock;

    public OperationExpiry(OperationJournal journal, OperationEvents events, TerminalNotifier terminal, OutcomeAudit outcomes, Clock clock) {
        this.journal = journal;
        this.events = events;
        this.terminal = terminal;
        this.outcomes = outcomes;
        this.clock = clock;
    }

    /** True when this call expired the operation; false when it was not waiting, not late, or another writer changed it first. */
    public boolean expireIfDue(OperationId id) {
        Optional<Operation> found = journal.find(id);
        if (found.isEmpty()) {
            return false;
        }
        Operation operation = found.orElseThrow();
        Instant now = clock.instant();
        if (!operation.state().isPreDispatch() || !operation.expiry().isReached(now)) {
            return false;
        }
        Operation expired = operation.expire(now);
        Operation stored;
        try {
            stored = journal.save(expired, operation.version());
        } catch (RequestRefusedException e) {
            if (e.code() == OperationErrorCode.OPERATION_VERSION_CONFLICT) {
                return false;
            }
            throw e;
        }
        events.changed(stored);
        terminal.ended(stored);
        outcomes.recordOutcome(stored);
        return true;
    }
}
