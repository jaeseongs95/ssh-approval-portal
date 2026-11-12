package io.github.jaeseongs95.portal.server.usecase;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import io.github.jaeseongs95.portal.app.output.StreamFrame;
import io.github.jaeseongs95.portal.app.output.StreamKind;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionPhase;
import io.github.jaeseongs95.portal.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.app.remote.ExecutionTimeline;
import io.github.jaeseongs95.portal.app.remote.OutputSink;
import io.github.jaeseongs95.portal.app.remote.RemoteExecution;
import io.github.jaeseongs95.portal.app.remote.RemoteExecutor;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
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

/**
 * The SSH boundary of the use case tests, the one thing that is not real: a {@link RemoteExecutor} that does what the test says and counts what it did. It follows the
 * contract of the real adapter in the one thing the use cases depend on: it calls the guard once, after "connecting" and before it "sends the request", and the request
 * counter rises only after the guard passed, so a test can say "no first byte was sent".
 *
 * <p>The behaviour is chosen by a marker in the command text: a command that contains the marker of a registered behaviour gets it; every other command exits with 0 and
 * writes {@code ok} to standard output.
 */
final class ScriptedExecutor implements RemoteExecutor {

    /** What the executor does with one command. */
    @FunctionalInterface
    interface Behavior {

        ExecutionReport run(RemoteExecution request, OutputSink sink, ExecutionControl control);
    }

    private final AtomicInteger requestsSent = new AtomicInteger();
    private final List<String> sent = new CopyOnWriteArrayList<>();
    private final Map<String, Behavior> behaviors = new ConcurrentHashMap<>();

    @Override
    public ExecutionReport run(RemoteExecution request, OutputSink sink, ExecutionControl control) {
        String line = request.command().commandLine();
        for (Map.Entry<String, Behavior> entry : behaviors.entrySet()) {
            if (line.contains(entry.getKey())) {
                return entry.getValue().run(request, sink, control);
            }
        }
        return exits(0, "ok\n").run(request, sink, control);
    }

    /** The behaviour of the commands that contain the marker. */
    void when(String marker, Behavior behavior) {
        behaviors.put(marker, behavior);
    }

    void reset() {
        behaviors.clear();
        requestsSent.set(0);
        sent.clear();
    }

    /** How many requests reached the "server": the guard passed and the request was written. */
    int requestsSent() {
        return requestsSent.get();
    }

    /** The command lines whose request was "sent", in order. */
    List<String> sentLines() {
        return List.copyOf(sent);
    }

    /** The command guards, sends the request, writes the text to standard output in the frames given, and exits with the code. */
    Behavior exits(int code, String... frames) {
        return (request, sink, control) -> {
            Instant start = Instant.now();
            control.guard().beforeDispatch();
            requestsSent.incrementAndGet();
            sent.add(request.command().commandLine());
            for (String frame : frames) {
                sink.accept(new StreamFrame(StreamKind.STDOUT, frame.getBytes(StandardCharsets.UTF_8)));
            }
            return new ExecutionReport(ExecutionOutcome.exited(code, List.of()), timeline(start));
        };
    }

    /** The command guards and sends the request, and then runs until the test counts the latch down; it then exits with 0. */
    Behavior blocksUntil(CountDownLatch release) {
        return (request, sink, control) -> {
            Instant start = Instant.now();
            control.guard().beforeDispatch();
            requestsSent.incrementAndGet();
            sent.add(request.command().commandLine());
            await(release);
            return new ExecutionReport(ExecutionOutcome.exited(0, List.of()), timeline(start));
        };
    }

    /** The command guards and sends the request, and then runs until it is asked to stop; it ends as a cancelled execution does: reason cancel, the process gone. */
    Behavior blocksUntilCancelled(CountDownLatch started) {
        return (request, sink, control) -> {
            Instant start = Instant.now();
            control.guard().beforeDispatch();
            requestsSent.incrementAndGet();
            sent.add(request.command().commandLine());
            CountDownLatch cancelled = new CountDownLatch(1);
            control.cancel().whenRequested().thenRun(cancelled::countDown);
            started.countDown();
            await(cancelled);
            ExecutionOutcome outcome = new ExecutionOutcome(ExecutionReason.CANCEL, RemoteState.EXITED, new ExitStatus.NoExit(), SignalDelivery.REQUESTED, CleanupState.COMPLETE,
                Reconciliation.NOT_REQUIRED, OutputState.COMPLETE, CaptureState.OK, new TimeoutMs.None(), new StreamCapture.NotCaptured(), new StreamCapture.NotCaptured(),
                new ExecutionFailure.Unclassified(), ResultFlag.FAILED, List.of(), new CompletionEvidence.NoEvidence());
            return new ExecutionReport(outcome, timeline(start));
        };
    }

    /** The command guards, sends the request and then the adapter fails with an exception that no result describes (text of the transport in the message). */
    Behavior failsUnexpectedly() {
        return (request, sink, control) -> {
            control.guard().beforeDispatch();
            requestsSent.incrementAndGet();
            sent.add(request.command().commandLine());
            throw new IllegalStateException("SECRET-TRANSPORT-CONTENT");
        };
    }

    private static ExecutionTimeline timeline(Instant start) {
        return ExecutionTimeline.empty().marked(ExecutionPhase.CONNECT_STARTED, start).marked(ExecutionPhase.CONNECTED, start.plusMillis(1))
            .marked(ExecutionPhase.REQUEST_SENT, start.plusMillis(2)).marked(ExecutionPhase.CLOSED, start.plusMillis(3));
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(15, TimeUnit.SECONDS)) {
                throw new IllegalStateException("The test never released the executor");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("The executor was interrupted", e);
        }
    }
}
