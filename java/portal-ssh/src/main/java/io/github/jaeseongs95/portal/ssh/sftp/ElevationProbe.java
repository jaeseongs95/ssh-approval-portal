package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.app.remote.CommandKind;
import io.github.jaeseongs95.portal.app.remote.ElevationPlan;
import io.github.jaeseongs95.portal.app.remote.ElevationRequest;
import io.github.jaeseongs95.portal.app.remote.ElevationResult;
import io.github.jaeseongs95.portal.app.remote.ExecReply;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.app.remote.FixedRemoteCommand;
import io.github.jaeseongs95.portal.app.remote.PreparedCommand;
import io.github.jaeseongs95.portal.app.remote.RemoteExecution;
import io.github.jaeseongs95.portal.app.remote.RemoteExecutor;
import io.github.jaeseongs95.portal.app.remote.SinkResult;
import io.github.jaeseongs95.portal.app.remote.StdinBytes;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.app.target.TargetSource;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import io.github.jaeseongs95.portal.domain.operation.ExitStatus;
import io.github.jaeseongs95.portal.domain.target.TargetLookup;
import java.util.Objects;
import org.springframework.stereotype.Component;

/**
 * Asks a target whether elevated file work is allowed (stage 3 design 6.1, decision Q8): it runs the fixed probe of the plan with the {@link RemoteExecutor} and reads
 * the exit code. A POSIX target's probe is {@code sudo -n} with a command that only succeeds when no password is needed; a Windows target's is a read-only query that
 * ends with 0 when the connection is the administrator's. The exit code is the whole answer: 0 grants, anything else denies, and a probe that did not end with an exit
 * code (the connection failed, the time ran out, the owner cancelled) is {@code Unavailable} with the reason, because "could not be asked" is not "no".
 *
 * <p>The probe is an external program on the target and not on this server, which is why Java cannot replace it: the target has no JVM (docs/external-programs). It
 * holds no user input. A plan without elevation is answered without a connection: {@code NotApplicable} with the operating system of the target, which the target source
 * knows.
 */
@Component
public class ElevationProbe {

    private final RemoteExecutor executor;
    private final TargetSource targets;

    /**
     * @param executor runs the probe on the target
     * @param targets where the operating system of a target is read from
     */
    public ElevationProbe(RemoteExecutor executor, TargetSource targets) {
        this.executor = Objects.requireNonNull(executor, "executor");
        this.targets = Objects.requireNonNull(targets, "targets");
    }

    /**
     * Runs the probe of the plan.
     *
     * @param request the target, the plan and the limits of the probe
     * @param control the owner's cancel and the check before dispatch
     * @return whether elevated file work is allowed, or why that could not be told
     */
    public ElevationResult check(ElevationRequest request, ExecutionControl control) {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(control, "control");
        return switch (request.plan()) {
            case ElevationPlan.NotSupported notSupported -> notApplicable(request);
            case ElevationPlan.SudoNonInteractive sudo -> run(request, sudo.probe(), control);
            case ElevationPlan.WindowsAdministratorCheck administrator -> run(request, administrator.probe(), control);
        };
    }

    private ElevationResult notApplicable(ElevationRequest request) {
        return switch (targets.lookup(request.target().id())) {
            case TargetLookup.Found found -> new ElevationResult.NotApplicable(found.target().target().os());
            case TargetLookup.NotRegistered notRegistered -> new ElevationResult.Unavailable(TransferFailureCause.CONNECT_FAILED);
            case TargetLookup.Disabled disabled -> new ElevationResult.Unavailable(TransferFailureCause.CONNECT_FAILED);
        };
    }

    private ElevationResult run(ElevationRequest request, FixedRemoteCommand probe, ExecutionControl control) {
        PreparedCommand command = new PreparedCommand(probe.commandLine(), StdinBytes.none(), CommandKind.COMMAND);
        // The reply to the request is not awaited: a probe that fails is "could not be asked" either way, and a server that does not answer must not make it wait.
        ExecutionReport report = executor.run(new RemoteExecution(request.target(), command, request.limits(), ExecReply.NOT_AWAITED), frame -> new SinkResult.Accepted(),
            control);
        ExecutionOutcome outcome = report.outcome();
        if (outcome.reason() == ExecutionReason.EXIT && outcome.failure().code() != ExecutionErrorCode.SSH_CONNECT_FAILED) {
            return answerOfExit(outcome.exit());
        }
        return new ElevationResult.Unavailable(causeOf(outcome));
    }

    /**
     * Why an execution did not end with an exit code, in the words of a file transfer: the reason the executor gave, or a failed connection (which the executor
     * reports as a failure code and not as a reason of its own).
     *
     * @param outcome what the executor reported
     * @return the cause; a lost connection when the outcome has no better reason
     */
    TransferFailureCause causeOf(ExecutionOutcome outcome) {
        if (outcome.failure().code() == ExecutionErrorCode.SSH_CONNECT_FAILED) {
            return TransferFailureCause.CONNECT_FAILED;
        }
        return switch (outcome.reason()) {
            case EXIT, TRANSPORT_LOST -> TransferFailureCause.TRANSPORT_LOST;
            case DEADLINE -> TransferFailureCause.DEADLINE;
            case CANCEL -> TransferFailureCause.CANCELLED;
            case CHANNEL_OPEN_FAILED -> TransferFailureCause.CHANNEL_OPEN_FAILED;
            case INPUT_FAILED -> TransferFailureCause.LOCAL_IO_FAILED;
        };
    }

    private ElevationResult answerOfExit(ExitStatus exit) {
        return switch (exit) {
            case ExitStatus.Exited exited -> exited.code() == 0 ? new ElevationResult.Granted() : new ElevationResult.Denied();
            case ExitStatus.Signaled signaled -> new ElevationResult.Unavailable(TransferFailureCause.TRANSPORT_LOST);
            case ExitStatus.NoExit noExit -> new ElevationResult.Unavailable(TransferFailureCause.TRANSPORT_LOST);
        };
    }
}
