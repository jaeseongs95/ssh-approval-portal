package io.github.jaeseongs95.portal.ssh.exec;

import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.error.ExecutionStage;
import io.github.jaeseongs95.portal.domain.error.RemoteOutcome;
import io.github.jaeseongs95.portal.domain.operation.CaptureState;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.operation.CompletionEvidence;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import io.github.jaeseongs95.portal.domain.operation.ExitStatus;
import io.github.jaeseongs95.portal.domain.operation.OutputState;
import io.github.jaeseongs95.portal.domain.operation.Reconciliation;
import io.github.jaeseongs95.portal.domain.operation.RemoteState;
import io.github.jaeseongs95.portal.domain.operation.ResultFlag;
import io.github.jaeseongs95.portal.domain.operation.SignalDelivery;
import io.github.jaeseongs95.portal.domain.operation.StreamCapture;
import io.github.jaeseongs95.portal.domain.operation.TimeoutMs;
import io.github.jaeseongs95.portal.domain.operation.Truncation;
import io.github.jaeseongs95.portal.ssh.session.ConnectFailure;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Component;

/**
 * Builds the {@link ExecutionOutcome} of an execution (stage 3 design 3.2, the table of the phases P0 to P12), so the table stays in one place and the supervisor only
 * gathers facts. The domain's own {@code ExecutionOutcome#verdict} then decides the operation's state from the outcome.
 *
 * <p>The texts are fixed sentences for the owner: no exception text, host name, command or output is ever put in one.
 *
 * <p>Two choices that {@link ExecutionReason} forces: it has no value for "the connection could not be made" or "the exec request was refused", so both are reported with
 * {@link ExecutionReason#CHANNEL_OPEN_FAILED}, the reason of a command that never started because no channel could be used; the failure's stage and code
 * ({@code SSH_CONNECT}/{@code SSH_CONNECT_FAILED}, {@code SSH_EXECUTION}/{@code SSH_EXECUTION_FAILED}) tell them apart (decision for the main to confirm).
 */
@Component
public final class ExecOutcomes {

    /** What the supervisor knows when a dispatched execution ends. */
    record Facts(ExitStatus exit, StopReason stop, boolean channelClosed, boolean outputDrained, SignalDelivery signals, StreamCapture stdout, StreamCapture stderr,
                 boolean captureFailed, Duration deadline, boolean sessionLost) {
    }

    /** Nothing was sent and the owner's stop (or the deadline) came first (P0). */
    ExecutionOutcome notDispatched(ExecutionReason reason) {
        String text = reason == ExecutionReason.CANCEL ? "The request was cancelled before the command was sent." : "The time limit passed before the command was sent.";
        return ExecutionOutcome.notDispatched(reason, List.of(text));
    }

    /** No session could be made (P1): {@code NOT_STARTED}, {@code SSH_CONNECT_FAILED}. */
    ExecutionOutcome connectFailed(ConnectFailure failure) {
        return refused(new ExecutionFailure.Classified(ExecutionStage.SSH_CONNECT, ExecutionErrorCode.SSH_CONNECT_FAILED, RemoteOutcome.NOT_STARTED),
            failure.cause().ownerText());
    }

    /** The server refused the channel, or the session had no free channel (P2): {@code NOT_STARTED}, {@code SSH_CHANNEL_OPEN_FAILED}. */
    ExecutionOutcome channelOpenFailed(String text) {
        return refused(new ExecutionFailure.Classified(ExecutionStage.SSH_CHANNEL, ExecutionErrorCode.SSH_CHANNEL_OPEN_FAILED, RemoteOutcome.NOT_STARTED), text);
    }

    /** The server answered the exec request with FAILURE (P4): {@code NOT_STARTED}, {@code SSH_EXECUTION_FAILED}. */
    ExecutionOutcome execRefused() {
        return refused(new ExecutionFailure.Classified(ExecutionStage.SSH_EXECUTION, ExecutionErrorCode.SSH_EXECUTION_FAILED, RemoteOutcome.NOT_STARTED),
            "The target refused the command request; the command did not start.");
    }

    private ExecutionOutcome refused(ExecutionFailure failure, String text) {
        return new ExecutionOutcome(ExecutionReason.CHANNEL_OPEN_FAILED, RemoteState.NOT_DISPATCHED, new ExitStatus.NoExit(), SignalDelivery.NOT_SENT, CleanupState.COMPLETE,
            Reconciliation.NOT_REQUIRED, OutputState.NOT_REPORTED, CaptureState.NOT_REPORTED, new TimeoutMs.None(), new StreamCapture.NotCaptured(), new StreamCapture.NotCaptured(),
            failure, ResultFlag.FAILED, List.of(text), new CompletionEvidence.NoEvidence());
    }

    /** The exec request was (or may have been) written: P5 to P10 and P12. */
    ExecutionOutcome afterDispatch(Facts facts) {
        boolean exited = !(facts.exit() instanceof ExitStatus.NoExit);
        boolean stopped = facts.stop() == StopReason.CANCEL || facts.stop() == StopReason.DEADLINE || facts.stop() == StopReason.INPUT_FAILED;
        ExecutionReason reason = switch (facts.stop()) {
            case CANCEL -> ExecutionReason.CANCEL;
            case DEADLINE -> ExecutionReason.DEADLINE;
            // When several failures overlap, the kind of cause decides, not the order they were noticed in (defect D-0038, the codes stay apart): a session that is gone
            // is a lost transport; a failed write of the input is INPUT_FAILED only while the session still lives (a write on a dead session fails because of the loss).
            case INPUT_FAILED -> facts.sessionLost() && !exited ? ExecutionReason.TRANSPORT_LOST : ExecutionReason.INPUT_FAILED;
            case NONE, REPLY_TIMEOUT -> exited ? ExecutionReason.EXIT : ExecutionReason.TRANSPORT_LOST;
        };
        boolean transportLost = reason == ExecutionReason.TRANSPORT_LOST;
        RemoteState remote = exited ? RemoteState.EXITED : RemoteState.UNKNOWN;
        // A channel that closed proves the cleanup of a lost transport (nothing is left to close) and of an execution whose end was seen; a stop without evidence leaves it open.
        CleanupState cleanup = facts.channelClosed() && (exited || transportLost) ? CleanupState.COMPLETE : CleanupState.INCOMPLETE;
        Reconciliation reconciliation = remote == RemoteState.UNKNOWN || cleanup == CleanupState.INCOMPLETE ? Reconciliation.REQUIRED : Reconciliation.NOT_REQUIRED;
        boolean truncated = isTruncated(facts.stdout()) || isTruncated(facts.stderr());
        OutputState outputState = exited && cleanup == CleanupState.COMPLETE && facts.outputDrained() && !truncated && !facts.captureFailed() ? OutputState.COMPLETE
            : OutputState.PARTIAL;
        TimeoutMs timeout = reason == ExecutionReason.DEADLINE ? new TimeoutMs.After(facts.deadline().toMillis()) : new TimeoutMs.None();
        ExecutionFailure failure = new ExecutionFailure.Unclassified();
        if (transportLost) {
            failure = new ExecutionFailure.Classified(ExecutionStage.SSH_EXECUTION, ExecutionErrorCode.SSH_EXECUTION_FAILED, RemoteOutcome.UNKNOWN);
        }
        if (facts.captureFailed()) {
            failure = new ExecutionFailure.Classified(ExecutionStage.OUTPUT_CAPTURE, ExecutionErrorCode.OUTPUT_CAPTURE_FAILED, exited ? RemoteOutcome.COMPLETED : RemoteOutcome.UNKNOWN);
        }
        boolean cleanExit = facts.exit() instanceof ExitStatus.Exited status && status.code() == 0;
        ResultFlag flag = cleanExit && reason == ExecutionReason.EXIT && !facts.captureFailed() ? ResultFlag.OK : ResultFlag.FAILED;
        CompletionEvidence evidence = facts.exit() instanceof ExitStatus.Exited status ? new CompletionEvidence.CommandExited(status.code()) : new CompletionEvidence.NoEvidence();
        List<String> texts = new ArrayList<>();
        texts.add(describe(reason, exited, stopped));
        if (truncated) {
            texts.add("The output was cut at the limit.");
        }
        if (facts.captureFailed()) {
            texts.add("The output could not be stored completely.");
        }
        return new ExecutionOutcome(reason, remote, facts.exit(), facts.signals(), cleanup, reconciliation, outputState, facts.captureFailed() ? CaptureState.FAILED : CaptureState.OK,
            timeout, facts.stdout(), facts.stderr(), failure, flag, texts, evidence);
    }

    private boolean isTruncated(StreamCapture capture) {
        return capture instanceof StreamCapture.Captured captured && captured.truncation() == Truncation.TRUNCATED;
    }

    private String describe(ExecutionReason reason, boolean exited, boolean stopped) {
        return switch (reason) {
            case EXIT -> "The command ended.";
            case TRANSPORT_LOST -> "The connection was lost after the command was sent; whether it ran is unknown.";
            case CANCEL, DEADLINE, INPUT_FAILED -> exited ? "The command was stopped and its end was seen." : stopped
                ? "A stop was requested; the end of the command was not confirmed." : "The command was stopped.";
            case CHANNEL_OPEN_FAILED -> "The command did not start.";
        };
    }
}
