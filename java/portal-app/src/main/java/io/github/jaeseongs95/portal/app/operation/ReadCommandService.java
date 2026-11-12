package io.github.jaeseongs95.portal.app.operation;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.CompletionException;

import org.springframework.stereotype.Service;

import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.app.target.TargetPlatform;
import io.github.jaeseongs95.portal.app.target.TargetPlatformRegistry;
import io.github.jaeseongs95.portal.domain.classify.CommandClass;
import io.github.jaeseongs95.portal.domain.error.DispatchRefusedException;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.operation.CommandInput;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.StartAuthority;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;

/**
 * The read-only command path (2.x {@code commands.run}, cases A-467 to A-469, B-356, B-358): a command the target's platform classifies as read-only is submitted,
 * approved under the server's read authority and queued like any operation, so it shares the scheduler and its limits with every other operation; then the caller
 * waits for the result up to the wait limit. Nothing here runs a command: the dispatcher does.
 *
 * <p>The refusals are the contract's own and never show text of the transport: a command that is not read-only is {@code READ_COMMAND_REQUIRES_APPROVAL}, one that could
 * not be started is {@code READ_COMMAND_NOT_STARTED} (the operation is cancelled, so it cannot start later), one whose outcome is unknown is
 * {@code READ_COMMAND_EXECUTION_UNKNOWN}. The method blocks the calling thread while it waits.
 */
@Service
public class ReadCommandService {

    private final CurrentTargets targets;
    private final TargetPlatformRegistry platforms;
    private final OperationIntake intake;
    private final OperationsService operations;
    private final Digester digester;
    private final Clock clock;

    public ReadCommandService(CurrentTargets targets, TargetPlatformRegistry platforms, OperationIntake intake, OperationsService operations, Digester digester, Clock clock) {
        this.targets = targets;
        this.platforms = platforms;
        this.intake = intake;
        this.operations = operations;
        this.digester = digester;
        this.clock = clock;
    }

    /** Runs the read-only command and returns the operation as it is after the wait: ended, or still running when the wait limit passed. */
    public Operation run(ReadCommandRequest request) {
        ResolvedTarget target = targets.require(request.target());
        TargetPlatform platform = platforms.platformOf(target.target().os());
        CommandClass commandClass = platform.classify(request.command()).forMultiline(request.command()).commandClass();
        if (commandClass != CommandClass.READ_ONLY) {
            throw new RequestRefusedException(RequestErrorCode.READ_COMMAND_REQUIRES_APPROVAL);
        }
        NewOperation spec = NewOperation.of(digester, request.key(), request.owner(), target.target().id(), target.revision(), target.target().readProfile(),
            new CommandInput(request.command(), request.callerContext(), request.displayContext()), new ConflictKey.None(), new Deadline.None());
        Operation submitted = intake.submit(spec);
        Operation queued = submitted;
        if (submitted.state() == OperationState.PENDING) {
            try {
                queued = intake.approve(submitted.id(), new StartAuthority.Policy(StartAuthority.PolicyScope.READ));
            } catch (DispatchRefusedException e) {
                operations.cancel(submitted.id());
                throw new RequestRefusedException(RequestErrorCode.READ_COMMAND_NOT_STARTED, e);
            }
        }
        Operation result = awaitEnd(queued.id(), request.waitLimit());
        if (result.state() == OperationState.UNKNOWN) {
            throw new RequestRefusedException(RequestErrorCode.READ_COMMAND_EXECUTION_UNKNOWN);
        }
        return result;
    }

    private Operation awaitEnd(OperationId id, Duration limit) {
        Instant until = clock.instant().plus(limit);
        Operation current = observe(id, limit);
        while (!current.state().isTerminal()) {
            Duration remaining = Duration.between(clock.instant(), until);
            if (remaining.isNegative() || remaining.isZero()) {
                return current;
            }
            current = observe(id, remaining);
        }
        return current;
    }

    private Operation observe(OperationId id, Duration wait) {
        try {
            return operations.observe(id, wait, new CancelSource()).toCompletableFuture().join().operation();
        } catch (CompletionException e) {
            if (e.getCause() instanceof RuntimeException cause) {
                throw cause;
            }
            throw e;
        }
    }
}
