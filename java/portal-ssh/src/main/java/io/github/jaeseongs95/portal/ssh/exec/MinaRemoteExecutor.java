package io.github.jaeseongs95.portal.ssh.exec;

import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionPhase;
import io.github.jaeseongs95.portal.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.app.remote.OutputSink;
import io.github.jaeseongs95.portal.app.remote.RemoteExecution;
import io.github.jaeseongs95.portal.app.remote.RemoteExecutor;
import io.github.jaeseongs95.portal.app.remote.SshSettings;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import io.github.jaeseongs95.portal.ssh.session.AcquireResult;
import io.github.jaeseongs95.portal.ssh.session.ChannelLease;
import io.github.jaeseongs95.portal.ssh.session.SshSessionPool;
import java.time.Clock;
import org.springframework.core.task.TaskExecutor;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.stereotype.Component;

/**
 * The {@link RemoteExecutor} of the SSH adapter on Apache MINA (stage 3 design 3.2 to 3.5). It gets a session from the {@link SshSessionPool} (the only place a connection is
 * made, and only before anything is sent), asks the owner's {@code DispatchGuard} once more, and hands the command to an {@link ExecSupervisor}, which owns it until it is
 * settled. The answer is always an {@link ExecutionReport}; the one thing thrown is the guard's {@code DispatchRefusedException}, with the lease given back first.
 *
 * <p>The request is sent at most once: nothing here, in the pool or in the supervisor repeats an exec request, whatever failed (decision D3-08, case S3-EX-09).
 * The three ways a command can fail to run stay three values: no session ({@code SSH_CONNECT_FAILED}, stage {@code ssh_connect}), no channel
 * ({@code SSH_CHANNEL_OPEN_FAILED}), and a transport lost after the request ({@code TRANSPORT_LOST}, unknown); a full execution queue is the scheduler's, never an adapter result.
 */
@Component
public final class MinaRemoteExecutor implements RemoteExecutor {

    private final SshSessionPool pool;
    private final TaskScheduler scheduler;
    private final TaskExecutor executor;
    private final Clock clock;
    private final ChannelSignals signals;
    private final SshSettings settings;
    private final ExecOutcomes outcomes;

    public MinaRemoteExecutor(SshSessionPool pool, TaskScheduler scheduler, TaskExecutor executor, Clock clock, ChannelSignals signals, SshSettings settings, ExecOutcomes outcomes) {
        this.pool = pool;
        this.scheduler = scheduler;
        this.executor = executor;
        this.clock = clock;
        this.signals = signals;
        this.settings = settings;
        this.outcomes = outcomes;
    }

    @Override
    public ExecutionReport run(RemoteExecution request, OutputSink sink, ExecutionControl control) {
        TimelineRecorder timeline = new TimelineRecorder(clock);
        ExecutionOutcome outcome = outcomeOf(request, sink, control, timeline);
        return new ExecutionReport(outcome, timeline.timeline());
    }

    private ExecutionOutcome outcomeOf(RemoteExecution request, OutputSink sink, ExecutionControl control, TimelineRecorder timeline) {
        if (control.cancel().requested()) {
            return outcomes.notDispatched(ExecutionReason.CANCEL);
        }
        timeline.mark(ExecutionPhase.CONNECT_STARTED);
        AcquireResult acquired = pool.acquire(request.target().profile(), control.cancel());
        return switch (acquired) {
            case AcquireResult.Cancelled cancelled -> outcomes.notDispatched(ExecutionReason.CANCEL);
            case AcquireResult.Failed failed -> outcomes.connectFailed(failed.failure());
            case AcquireResult.NoChannelPermit noPermit -> outcomes.channelOpenFailed("The session already has its permitted number of channels open; the command was not sent.");
            case AcquireResult.Leased leased -> runOnLease(request, sink, control, timeline, leased.lease());
        };
    }

    private ExecutionOutcome runOnLease(RemoteExecution request, OutputSink sink, ExecutionControl control, TimelineRecorder timeline, ChannelLease lease) {
        timeline.mark(ExecutionPhase.CONNECTED);
        try {
            if (control.cancel().requested()) {
                return outcomes.notDispatched(ExecutionReason.CANCEL);
            }
            // The last check before anything is sent (P3). The channel is opened after it: a target changed while the connection was being made is never reached.
            control.guard().beforeDispatch();
            return new ExecSupervisor(request, sink, control, lease, timeline, scheduler, executor, clock, signals, settings, outcomes).run();
        } finally {
            lease.close(); // the supervisor has given it back already when it ran; closing twice does nothing
        }
    }
}
