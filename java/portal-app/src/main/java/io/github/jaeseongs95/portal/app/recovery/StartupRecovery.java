package io.github.jaeseongs95.portal.app.recovery;

import java.time.Clock;
import java.util.List;
import java.util.Set;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.event.OperationEvents;
import io.github.jaeseongs95.portal.app.execution.ExecutionDispatcher;
import io.github.jaeseongs95.portal.app.journal.OperationQueueView;
import io.github.jaeseongs95.portal.app.journal.RestartRecovery;
import io.github.jaeseongs95.portal.app.journal.TargetFilter;
import io.github.jaeseongs95.portal.app.operation.ExpiryTimers;
import io.github.jaeseongs95.portal.app.operation.TerminalNotifier;
import io.github.jaeseongs95.portal.domain.error.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.error.PortalException;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;

/**
 * What the start of the application does about the operations that were in flight when it last stopped (stage 3 design 8.2 group G8, cases B-493 to B-495, T18 to T21).
 * The journal closes them in one transaction ({@link RestartRecovery}): what was running or being evaluated becomes {@code UNKNOWN} with the reason {@code BRIDGE_RESTART}
 * and the owner reconciles it, what waited for the owner expires, what was only queued stays queued. <b>Nothing is sent again.</b> This class then announces what changed
 * (the waiters, the listeners of terminal operations), arms the timers of the operations that still wait, and opens the dispatcher for the queue that remains.
 *
 * <p><b>When it runs.</b> It is a {@link SmartInitializingSingleton}: Spring calls {@link #afterSingletonsInstantiated()} once per bean factory, after all singletons exist.
 * The product has one parent (non-web) context and two child web contexts; the refresh event of a child is also delivered to the listeners of the parent, so a
 * {@code ContextRefreshedEvent} listener would recover the journal more than once. This callback belongs to the factory that owns the bean, so it runs once.
 * The dispatcher is closed until this method has finished, so the first claim never runs before the recovery. A recovery that cannot be stored stops the start with
 * {@code OPERATION_STORE_FAILED} and the dispatcher stays closed: serving requests over a journal that was not recovered would claim operations that the last run
 * still holds.
 */
@Component
public class StartupRecovery implements SmartInitializingSingleton {

    private static final Logger LOG = LoggerFactory.getLogger(StartupRecovery.class);

    private final RestartRecovery recovery;
    private final OperationQueueView queueView;
    private final OperationEvents events;
    private final TerminalNotifier terminal;
    private final ExpiryTimers timers;
    private final ExecutionDispatcher dispatcher;
    private final ConcurrencyLimits limits;
    private final Clock clock;

    public StartupRecovery(RestartRecovery recovery, OperationQueueView queueView, OperationEvents events, TerminalNotifier terminal, ExpiryTimers timers,
                           ExecutionDispatcher dispatcher, ConcurrencyLimits limits, Clock clock) {
        this.recovery = recovery;
        this.queueView = queueView;
        this.events = events;
        this.terminal = terminal;
        this.timers = timers;
        this.dispatcher = dispatcher;
        this.limits = limits;
        this.clock = clock;
    }

    @Override
    public void afterSingletonsInstantiated() {
        recover();
    }

    /** Recovers the journal, announces what changed, and opens the dispatcher. Returns the operations the recovery changed, in their new state. */
    public List<Operation> recover() {
        List<Operation> changed;
        try {
            changed = recovery.recoverAfterRestart(clock.instant());
        } catch (PortalException e) {
            throw e;
        } catch (RuntimeException e) {
            throw new RequestRefusedException(OperationErrorCode.OPERATION_STORE_FAILED, e);
        }
        for (Operation operation : changed) {
            events.changed(operation);
            if (operation.state().isTerminal()) {
                terminal.ended(operation);
            }
        }
        for (Operation queued : queueView.inStates(Set.of(OperationState.QUEUED), new TargetFilter.AnyTarget(), limits.queueCapacity().value())) {
            timers.arm(queued);
        }
        LOG.info("The journal was recovered after the start: {} operation(s) were in flight and are closed; none is sent again", changed.size());
        dispatcher.open();
        return changed;
    }
}
