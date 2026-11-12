package io.github.jaeseongs95.portal.store.journal;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import io.github.jaeseongs95.portal.app.journal.RestartRecovery;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;

/**
 * {@link RestartRecovery} over the journal: every operation that is not in a terminal state when the application starts is handed to {@code Operation#recoverAfterRestart},
 * which decides the new state (design 2.3, T18 to T21; a queued operation stays queued), and a changed result is stored through the same compare-and-set as every
 * transition, so the slots of an operation that was active are released and its events are written. All of it is one transaction: a failure leaves the journal as it was. An operation whose outcome is unknown is not
 * sent again; the next start finds it in a terminal state and leaves it alone.
 */
@Repository
public class JdbcRestartRecovery implements RestartRecovery {

    /** The states that are not terminal, derived from the domain so that the two cannot drift apart. */
    private static final Set<OperationState> IN_FLIGHT = Arrays.stream(OperationState.values()).filter(state -> !state.isTerminal())
        .collect(Collectors.toCollection(() -> EnumSet.noneOf(OperationState.class)));

    private final OperationRowRepository operations;
    private final OperationStorage storage;

    public JdbcRestartRecovery(OperationRowRepository operations, OperationStorage storage) {
        this.operations = operations;
        this.storage = storage;
    }

    @Override
    @Transactional
    public List<Operation> recoverAfterRestart(Instant at) {
        List<Operation> changed = new ArrayList<>();
        for (OperationRow row : operations.findByStateIn(IN_FLIGHT)) {
            Operation current = storage.load(row);
            Operation next = current.recoverAfterRestart(at);
            if (next.version() == current.version()) {
                // The domain leaves it as it is (a queued operation was never tried, the scheduler dispatches or expires it as usual): nothing is written.
                continue;
            }
            changed.add(storage.persist(row, next, row.version()));
        }
        return List.copyOf(changed);
    }
}
