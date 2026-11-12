package io.github.jaeseongs95.portal.app.execution;

import java.util.List;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionLimits;
import io.github.jaeseongs95.portal.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.app.remote.ExecutionTimeline;
import io.github.jaeseongs95.portal.app.remote.PreparedCommand;
import io.github.jaeseongs95.portal.app.remote.RemoteExecution;
import io.github.jaeseongs95.portal.app.remote.RemoteExecutor;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;
import io.github.jaeseongs95.portal.app.remote.WorkingDirectory;
import io.github.jaeseongs95.portal.app.target.TargetPlatform;
import io.github.jaeseongs95.portal.app.target.TargetPlatformRegistry;
import io.github.jaeseongs95.portal.app.target.TargetSource;
import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchRefusedException;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.error.PortalException;
import io.github.jaeseongs95.portal.domain.operation.CommandInput;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationKind;
import io.github.jaeseongs95.portal.domain.path.PathSyntax;
import io.github.jaeseongs95.portal.domain.target.AccessMode;
import io.github.jaeseongs95.portal.domain.target.ConnectionProfile;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;
import io.github.jaeseongs95.portal.domain.target.Setting;
import io.github.jaeseongs95.portal.domain.target.TargetLookup;
import io.github.jaeseongs95.portal.domain.target.WindowsDirectory;

/**
 * Runs the operations of kind {@code COMMAND} (stage 3 design 1.1 F, 3.2, 3.4). It resolves the target, lets the target's platform make the command ready for the
 * target's shell, reserves the output, and hands the command to the {@link RemoteExecutor} with the output as its sink. It knows no operating system and no SSH
 * library: the platform and the executor are the two extension points. The executor sends the request at most once; this class has no path that sends it again.
 *
 * <p>A script operation ({@code SOURCE}) is not run here: its text lives in a private plan that this class does not have, so the dispatcher refuses it before dispatch
 * until the source runner exists.
 */
@Component
public class CommandOperationRunner implements OperationRunner {

    private final RemoteExecutor executor;
    private final TargetSource targets;
    private final TargetPlatformRegistry platforms;
    private final CommandOutputWriter outputs;
    private final ExecutionLimits limits;

    public CommandOperationRunner(RemoteExecutor executor, TargetSource targets, TargetPlatformRegistry platforms, CommandOutputWriter outputs, ExecutionLimits limits) {
        this.executor = executor;
        this.targets = targets;
        this.platforms = platforms;
        this.outputs = outputs;
        this.limits = limits;
    }

    @Override
    public OperationKind kind() {
        return OperationKind.COMMAND;
    }

    @Override
    public ExecutionReport run(Operation operation, ExecutionControl control) {
        if (!(operation.input() instanceof CommandInput input)) {
            throw new IllegalArgumentException("Not a command operation: " + operation.kind());
        }
        if (!(targets.lookup(operation.targetId()) instanceof TargetLookup.Found found)) {
            throw new DispatchRefusedException(DispatchFailure.refused(DispatchReason.TARGET_CHANGED, DispatchStage.TARGET_GUARD));
        }
        ResolvedTarget resolved = found.target();
        TargetPlatform platform = platforms.platformOf(resolved.target().os());
        AccessMode access = operation.profile().equals(resolved.target().readProfile()) ? AccessMode.READ_ONLY : AccessMode.READ_WRITE;
        ConnectionProfile profile = access == AccessMode.READ_ONLY ? resolved.reader() : resolved.writer();
        PreparedCommand prepared = prepare(platform, resolved, profile, input);
        RemoteExecution execution = new RemoteExecution(new RemoteTarget(operation.targetId(), operation.targetRevision(), operation.profile(), access), prepared, limits,
            platform.execReply());
        return switch (outputs.open(operation, limits)) {
            case OutputOpening.Refused refused -> refusedBeforeStart(refused.failure());
            case OutputOpening.Opened opened -> runWith(opened.output(), execution, control);
        };
    }

    /** Runs the command with the reserved output. An output that was reserved and not used is given up, whatever ended the run. */
    private ExecutionReport runWith(OpenOutput output, RemoteExecution execution, ExecutionControl control) {
        ExecutionReport report;
        try {
            report = executor.run(execution, output, control);
        } catch (RuntimeException e) {
            output.abandon();
            throw e;
        }
        return new ExecutionReport(output.finish(report.outcome()), report.timeline());
    }

    /** Makes the command ready for the shell; a command the platform cannot take is refused before dispatch, with no text of the command in the refusal. */
    private PreparedCommand prepare(TargetPlatform platform, ResolvedTarget resolved, ConnectionProfile profile, CommandInput input) {
        try {
            return platform.prepareCommand(input.command(), workdirOf(platform.pathSyntax(), resolved, profile));
        } catch (PortalException | IllegalArgumentException e) {
            throw new DispatchRefusedException(DispatchFailure.refused(DispatchReason.INVALID_COMMAND, DispatchStage.COMMAND_VALIDATION), e);
        }
    }

    /** The directory a command starts in: the Windows setting of the target, then the working directory of the profile, then the login directory. */
    private WorkingDirectory workdirOf(PathSyntax syntax, ResolvedTarget resolved, ConnectionProfile profile) {
        if (resolved.target().windows().workdir() instanceof Setting.Given<WindowsDirectory> windows) {
            return new WorkingDirectory.At(syntax.path(windows.value().value()));
        }
        if (profile.workdir() instanceof Setting.Given<String> posix) {
            return new WorkingDirectory.At(syntax.path(posix.value()));
        }
        return new WorkingDirectory.Default();
    }

    /** The command was not started because its output could not be reserved: failed, certain, nothing sent. */
    private ExecutionReport refusedBeforeStart(ExecutionFailure failure) {
        ExecutionOutcome base = ExecutionOutcome.notDispatched(ExecutionReason.INPUT_FAILED, List.of("The output of the command could not be reserved"));
        ExecutionOutcome refused = new ExecutionOutcome(base.reason(), base.remoteState(), base.exit(), base.signalDelivery(), base.cleanup(), base.reconciliation(),
            base.outputState(), base.capture(), base.timeout(), base.stdout(), base.stderr(), failure, base.failed(), base.texts(), base.evidence());
        return new ExecutionReport(refused, ExecutionTimeline.empty());
    }
}
