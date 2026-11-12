package io.github.jaeseongs95.portal.ssh.exec;

import io.github.jaeseongs95.portal.app.output.StreamKind;
import io.github.jaeseongs95.portal.app.remote.ExecReply;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionLimits;
import io.github.jaeseongs95.portal.app.remote.ExecutionPhase;
import io.github.jaeseongs95.portal.app.remote.OutputSink;
import io.github.jaeseongs95.portal.app.remote.RemoteExecution;
import io.github.jaeseongs95.portal.app.remote.SshSettings;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import io.github.jaeseongs95.portal.domain.operation.ExitStatus;
import io.github.jaeseongs95.portal.domain.operation.SignalDelivery;
import io.github.jaeseongs95.portal.domain.operation.StreamCapture;
import io.github.jaeseongs95.portal.domain.operation.Truncation;
import io.github.jaeseongs95.portal.ssh.session.ChannelLease;
import java.io.Closeable;
import java.io.IOException;
import java.io.OutputStream;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ScheduledFuture;
import org.apache.sshd.client.future.OpenFuture;
import org.apache.sshd.common.channel.Channel;
import org.apache.sshd.common.channel.ChannelListener;
import org.apache.sshd.common.channel.exception.SshChannelOpenException;
import org.apache.sshd.common.session.ConnectionService;
import org.apache.sshd.core.CoreModuleProperties;
import org.springframework.core.task.TaskExecutor;
import org.springframework.scheduling.TaskScheduler;

/**
 * Runs one command on one channel and owns everything that happens to it, from the open of the channel to the settled {@link ExecutionOutcome} (stage 3 design 3.2 and 3.3).
 * One instance runs one execution; {@link MinaRemoteExecutor} makes it.
 *
 * <p>It is driven by events (the channel's confirmation, the server's answer to the exec request, the exit status, the close of the channel, the end of the output streams)
 * and by three timers on the injected scheduler (the deadline, the steps of a stop, the guards that keep every wait finite); the calling thread only waits for the outcome.
 * All state is guarded by this object's monitor; calls into MINA (a signal, a close) are made after the monitor is released.
 *
 * <p><b>The request is sent at most once.</b> There is no retry anywhere here. Before the exec request is written the run can be stopped with certainty that nothing was sent
 * ({@link SupervisedExecChannel#abandonIfNotSent()}); after it, the end of the command is known only from evidence (an exit status or signal), and the close of a channel is
 * not evidence (the stop procedure, 3.3: INT at once, TERM after a third of the grace, KILL after two thirds, then a graceful close).
 */
final class ExecSupervisor implements SupervisedExecChannel.Events {

    private enum Phase { OPENING, RUNNING, DONE }

    private final RemoteExecution request;
    private final OutputSink sink;
    private final ExecutionControl control;
    private final ChannelLease lease;
    private final TimelineRecorder timeline;
    private final TaskScheduler scheduler;
    private final TaskExecutor executor;
    private final Clock clock;
    private final ChannelSignals signals;
    private final SshSettings settings;
    private final ExecOutcomes outcomes;
    private final SupervisedExecChannel channel;
    private final CompletableFuture<ExecutionOutcome> settled = new CompletableFuture<>();
    private final CompletableFuture<Void> stdinDone = new CompletableFuture<>();
    private final List<ScheduledFuture<?>> timers = new ArrayList<>();

    // The state below is guarded by this.
    private Phase phase = Phase.OPENING;
    private StopReason stop = StopReason.NONE;
    private ExitStatus exit = new ExitStatus.NoExit();
    private SignalDelivery signalDelivery = SignalDelivery.NOT_SENT;
    private boolean replyAnswered;
    private boolean refused;
    private boolean closed;
    private boolean stopProcedureStarted;
    private boolean closingScheduled;
    private boolean drainGuardScheduled;
    private OutputPump stdout;
    private OutputPump stderr;
    private volatile Duration closeTimeout = Duration.ofSeconds(5);

    ExecSupervisor(RemoteExecution request, OutputSink sink, ExecutionControl control, ChannelLease lease, TimelineRecorder timeline, TaskScheduler scheduler,
                   TaskExecutor executor, Clock clock, ChannelSignals signals, SshSettings settings, ExecOutcomes outcomes) {
        this.request = request;
        this.sink = sink;
        this.control = control;
        this.lease = lease;
        this.timeline = timeline;
        this.scheduler = scheduler;
        this.executor = executor;
        this.clock = clock;
        this.signals = signals;
        this.settings = settings;
        this.outcomes = outcomes;
        this.channel = new SupervisedExecChannel(request.command().commandLine(), this, lease.tty());
    }

    /** Runs the command and returns when the execution is settled; the channel is closed (or its close started) before it returns. */
    ExecutionOutcome run() {
        CoreModuleProperties.REQUEST_EXEC_REPLY.set(channel, Boolean.valueOf(request.reply() == ExecReply.AWAITED));
        try {
            lease.session().getService(ConnectionService.class).registerChannel(channel);
        } catch (IOException | RuntimeException e) {
            lease.sessionLost();
            return outcomes.channelOpenFailed("The session could not open a channel; the command was not sent.");
        }
        closeTimeout = CoreModuleProperties.CHANNEL_CLOSE_TIMEOUT.getRequired(channel);
        channel.addChannelListener(new ChannelListener() {
            @Override
            public void channelStateChanged(Channel changed, String hint) {
                observeExit();
            }

            @Override
            public void channelClosed(Channel closedChannel, Throwable reason) {
                onClosed();
            }
        });
        ExecutionLimits limits = request.limits();
        control.cancel().whenRequested().thenRun(() -> requestStop(StopReason.CANCEL));
        schedule(limits.deadline(), () -> requestStop(StopReason.DEADLINE));
        if (!settled.isDone()) {
            try {
                channel.open().addListener(this::openCompleted);
            } catch (IOException | RuntimeException e) {
                openFailed(e);
            }
        }
        ExecutionOutcome outcome = settled.join();
        finish(outcome);
        return outcome;
    }

    /** Closes the channel if it is still open and gives the lease back; a lost transport takes the session out of the pool. */
    private void finish(ExecutionOutcome outcome) {
        boolean stillOpen;
        synchronized (this) {
            stillOpen = !closed;
        }
        if (stillOpen) {
            try {
                // The permit goes back only when the channel is closed (or MINA's own close timeout has passed), so the session never has more channels than it permits.
                channel.close(false).await(closeTimeout);
            } catch (IOException e) {
                // The wait was interrupted or the close failed; the channel is closing either way.
            }
        }
        // A pump that is still reading (a forced settle) ends when its pipe is closed; a pump that has ended has nothing left to lose.
        closeQuietly(channel.getInvertedOut());
        closeQuietly(channel.getInvertedErr());
        closeQuietly(channel.getInvertedIn()); // a writer of the input that is still blocked on the window ends here
        if (outcome.reason() == ExecutionReason.TRANSPORT_LOST && !lease.session().isOpen()) {
            lease.sessionLost();
        }
        lease.close();
    }

    private void closeQuietly(Closeable stream) {
        if (stream == null) {
            return;
        }
        try {
            stream.close();
        } catch (IOException e) {
            // Closing a pipe that has ended is not an error worth reporting.
        }
    }

    // ---- events of the channel -------------------------------------------------------------------------------------------------------------------------------

    @Override
    public void channelConfirmed() {
        lease.openAccepted();
        timeline.mark(ExecutionPhase.CHANNEL_OPENED);
    }

    @Override
    public void requestWritten() {
        boolean interrupt = false;
        synchronized (this) {
            if (phase == Phase.DONE) {
                return;
            }
            timeline.mark(ExecutionPhase.REQUEST_SENT);
            phase = Phase.RUNNING;
            startOutput();
            try {
                executor.execute(this::writeStdin);
            } catch (RuntimeException e) {
                stdinDone.complete(null);
            }
            if (request.reply() == ExecReply.AWAITED) {
                schedule(settings.execReplyTimeout(), this::replyTimedOut);
            }
            if (stop != StopReason.NONE) {
                interrupt = beginStopProcedure() && !closed;
            }
        }
        if (interrupt) {
            sendSignal(ChannelSignals.INTERRUPT);
        }
    }

    @Override
    public void outputArrived() {
        timeline.mark(ExecutionPhase.FIRST_OUTPUT);
    }

    @Override
    public void replyReceived(boolean accepted) {
        synchronized (this) {
            replyAnswered = true;
            if (!accepted) {
                refused = true;
                evaluate();
            }
        }
    }

    private void openCompleted(OpenFuture future) {
        try {
            future.verify();
        } catch (IOException e) {
            openFailed(e);
        }
    }

    /** The channel could not be opened (P2): a refusal by the server, or a session that is gone. Nothing was sent unless the request was already written. */
    private void openFailed(Exception failure) {
        synchronized (this) {
            if (phase == Phase.DONE) {
                return; // the run was stopped first and abandoned the channel: this failure is its own doing, not the server's
            }
        }
        boolean rejected = isRejection(failure);
        // The lease learns what happened before the run is settled, so the pool counts it before the lease is given back.
        if (rejected) {
            lease.openRejected();
        } else if (!lease.session().isOpen()) {
            lease.sessionLost();
        }
        synchronized (this) {
            if (phase == Phase.DONE) {
                return;
            }
            if (channel.abandonIfNotSent()) {
                settle(outcomes.channelOpenFailed(rejected ? "The target refused to open a channel; the command was not sent." : "A channel could not be opened; the command was not sent."));
            } else {
                phase = Phase.RUNNING;
                settleNow();
            }
        }
    }

    private boolean isRejection(Throwable failure) {
        for (Throwable current = failure; current != null; current = current.getCause()) {
            if (current instanceof SshChannelOpenException) {
                return true;
            }
        }
        return false;
    }

    /** The exit status or exit signal of the command, if the server has sent one (the channel notifies its listeners when it arrives). */
    private void observeExit() {
        Integer code = channel.getExitStatus();
        String signal = channel.getExitSignal();
        synchronized (this) {
            if (phase == Phase.DONE || !(exit instanceof ExitStatus.NoExit) || code == null && signal == null) {
                return;
            }
            exit = code != null ? new ExitStatus.Exited(code) : signaled(signal);
            timeline.mark(ExecutionPhase.EXIT_SEEN);
            if (stop == StopReason.NONE && phase == Phase.RUNNING) {
                scheduleClosing(request.limits().stopGrace());
            }
            evaluate();
        }
    }

    private ExitStatus signaled(String name) {
        String normalised = name.toUpperCase(Locale.ROOT);
        if (normalised.startsWith("SIG")) {
            normalised = normalised.substring(3);
        }
        try {
            return new ExitStatus.Signaled(normalised);
        } catch (IllegalArgumentException e) {
            return new ExitStatus.Signaled("UNKNOWN");
        }
    }

    private void onClosed() {
        synchronized (this) {
            closed = true;
            timeline.mark(ExecutionPhase.CLOSED);
        }
        observeExit();
        synchronized (this) {
            evaluate();
        }
    }

    // ---- settling -----------------------------------------------------------------------------------------------------------------------------------------

    /** Decides whether the execution can be settled now. Called with the monitor held. */
    private void evaluate() {
        if (phase == Phase.DONE) {
            return;
        }
        if (refused && closed) {
            settle(outcomes.execRefused());
            return;
        }
        if (phase == Phase.RUNNING && closed) {
            // The writer of the standard input is awaited too: it learns that the channel is gone and says so (INPUT_FAILED) before the run is settled as a lost transport.
            if (outputDone() && stdinDone.isDone()) {
                settleNow();
            } else if (!drainGuardScheduled) {
                drainGuardScheduled = true;
                schedule(request.limits().stopGrace(), this::settleIfRunning);
            }
        }
    }

    private boolean outputDone() {
        return stdout != null && stderr != null && stdout.done().isDone() && stderr.done().isDone();
    }

    private void settleIfRunning() {
        synchronized (this) {
            if (phase == Phase.RUNNING) {
                settleNow();
            }
        }
    }

    /** Settles a dispatched execution from the facts at hand. Called with the monitor held. */
    private void settleNow() {
        StreamCapture out = stdout == null ? emptyCapture() : stdout.capture();
        StreamCapture err = stderr == null ? emptyCapture() : stderr.capture();
        boolean captureFailed = stdout != null && stdout.sinkFailed() || stderr != null && stderr.sinkFailed();
        ExecOutcomes.Facts facts = new ExecOutcomes.Facts(exit, stop, closed, outputDone(), signalDelivery, out, err, captureFailed, request.limits().deadline(),
            !lease.session().isOpen());
        settle(outcomes.afterDispatch(facts));
    }

    private StreamCapture emptyCapture() {
        return new StreamCapture.Captured(0, 0, 0, Truncation.COMPLETE);
    }

    /** Fixes the outcome (once) and stops every timer. Called with the monitor held. */
    private void settle(ExecutionOutcome outcome) {
        if (phase == Phase.DONE) {
            return;
        }
        phase = Phase.DONE;
        for (ScheduledFuture<?> timer : timers) {
            timer.cancel(false);
        }
        settled.complete(outcome);
    }

    // ---- stop ---------------------------------------------------------------------------------------------------------------------------------------------

    private void requestStop(StopReason reason) {
        boolean closeNow = false;
        boolean interrupt = false;
        synchronized (this) {
            if (phase == Phase.DONE || stop != StopReason.NONE) {
                return;
            }
            stop = reason;
            if (phase == Phase.OPENING) {
                if (channel.abandonIfNotSent()) {
                    settle(outcomes.notDispatched(notDispatchedReason(reason)));
                    closeNow = true;
                }
                // Otherwise the request is being written: requestWritten() starts the stop procedure.
            } else {
                interrupt = beginStopProcedure() && !closed;
            }
        }
        if (closeNow) {
            closeChannel();
        }
        if (interrupt) {
            sendSignal(ChannelSignals.INTERRUPT);
        }
    }

    private ExecutionReason notDispatchedReason(StopReason reason) {
        return switch (reason) {
            case CANCEL -> ExecutionReason.CANCEL;
            case DEADLINE -> ExecutionReason.DEADLINE;
            case NONE, INPUT_FAILED, REPLY_TIMEOUT -> throw new IllegalStateException("A stop before the request was written is a cancel or the deadline: " + reason);
        };
    }

    /**
     * Schedules the later steps of the stop (TERM, KILL, the graceful close, the last-resort settle). Called with the monitor held.
     *
     * @return true for the first call: the caller then sends the INT signal, outside the monitor
     */
    private boolean beginStopProcedure() {
        if (stopProcedureStarted) {
            return false;
        }
        stopProcedureStarted = true;
        Duration grace = request.limits().stopGrace();
        long third = Math.max(1, grace.toMillis() / 3);
        schedule(Duration.ofMillis(third), () -> signalLater(ChannelSignals.TERMINATE));
        schedule(Duration.ofMillis(2 * third), () -> signalLater(ChannelSignals.KILL));
        scheduleClosing(grace);
        return true;
    }

    private void signalLater(String name) {
        synchronized (this) {
            if (phase == Phase.DONE || closed) {
                return;
            }
        }
        sendSignal(name);
    }

    private void sendSignal(String name) {
        SignalDelivery delivery = signals.send(channel, name);
        synchronized (this) {
            if (delivery == SignalDelivery.UNSUPPORTED) {
                signalDelivery = SignalDelivery.UNSUPPORTED;
            } else if (signalDelivery == SignalDelivery.NOT_SENT) {
                signalDelivery = SignalDelivery.REQUESTED;
            }
        }
    }

    /** After {@code after} the channel is closed gracefully; after the channel's own close timeout on top of that the execution is settled whatever has not arrived. */
    private void scheduleClosing(Duration after) {
        if (closingScheduled) {
            return;
        }
        closingScheduled = true;
        schedule(after, this::forceClose);
        schedule(after.plus(closeTimeout).plusMillis(250), this::settleIfRunning);
    }

    private void forceClose() {
        synchronized (this) {
            if (phase == Phase.DONE || closed) {
                return;
            }
        }
        closeChannel();
    }

    private void replyTimedOut() {
        synchronized (this) {
            if (replyAnswered || phase != Phase.RUNNING) {
                return;
            }
        }
        requestStop(StopReason.REPLY_TIMEOUT);
    }

    private void closeChannel() {
        channel.close(false);
    }

    private void schedule(Duration delay, Runnable action) {
        ScheduledFuture<?> timer = scheduler.schedule(action, clock.instant().plus(delay));
        synchronized (this) {
            timers.add(timer);
        }
    }

    // ---- output and input ---------------------------------------------------------------------------------------------------------------------------------

    /** Starts the two pumps on the inverted streams of the channel. Called with the monitor held, after the exec request was written. */
    private void startOutput() {
        long cap = request.limits().outputPerStream().toBytes();
        stdout = new OutputPump(StreamKind.STDOUT, channel.getInvertedOut(), sink, cap);
        stderr = new OutputPump(StreamKind.STDERR, channel.getInvertedErr(), sink, cap);
        CompletableFuture.allOf(stdout.start(executor), stderr.start(executor)).thenRun(() -> {
            synchronized (this) {
                evaluate();
            }
        });
    }

    /** Writes the standard input and closes it (the end of the input is sent to the command). A failure stops the run (P12, 2.x {@code input_failed}). */
    private void writeStdin() {
        byte[] bytes = request.command().stdin().bytes();
        try (OutputStream input = channel.getInvertedIn()) {
            if (bytes.length > 0) {
                input.write(bytes);
                input.flush();
            }
        } catch (IOException e) {
            requestStop(StopReason.INPUT_FAILED);
        } finally {
            stdinDone.complete(null);
            synchronized (this) {
                evaluate();
            }
        }
    }
}
