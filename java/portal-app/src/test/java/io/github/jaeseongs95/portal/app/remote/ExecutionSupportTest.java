package io.github.jaeseongs95.portal.app.remote;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.app.output.StreamFrame;
import io.github.jaeseongs95.portal.app.output.StreamKind;

/** The timeline, the cancel, the guard and the sink of an execution (stage 3 design 2.2, 3.3, 3.4). */
class ExecutionSupportTest {

    private static final Instant T0 = Instant.parse("2026-11-12T00:00:00Z");

    @Test
    @DisplayName("S3-SS-05 a timeline keeps the marks in order, once each, and never lets a mark be earlier than the one before it")
    void timelineIsOrderedAndOnceEach() {
        ExecutionTimeline timeline = ExecutionTimeline.empty().marked(ExecutionPhase.CONNECT_STARTED, T0).marked(ExecutionPhase.CONNECTED, T0.plusMillis(30))
            .marked(ExecutionPhase.CHANNEL_OPENED, T0.plusMillis(30));
        assertThat(timeline.marks()).extracting(PhaseMark::phase).containsExactly(ExecutionPhase.CONNECT_STARTED, ExecutionPhase.CONNECTED, ExecutionPhase.CHANNEL_OPENED);
        assertThatThrownBy(() -> timeline.marked(ExecutionPhase.CONNECTED, T0.plusMillis(40))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> timeline.marked(ExecutionPhase.REQUEST_SENT, T0.plusMillis(29))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ExecutionTimeline(List.of(new PhaseMark(ExecutionPhase.CLOSED, T0), new PhaseMark(ExecutionPhase.CLOSED, T0))))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S3-SS-05 a connection that failed has only its first mark: a phase not reached is absent, not zero")
    void aPhaseNotReachedIsAbsent() {
        ExecutionTimeline failed = ExecutionTimeline.empty().marked(ExecutionPhase.CONNECT_STARTED, T0);
        assertThat(failed.at(ExecutionPhase.CONNECT_STARTED)).contains(T0);
        assertThat(failed.at(ExecutionPhase.REQUEST_SENT)).isEmpty();
        assertThat(ExecutionTimeline.empty().marks()).isEmpty();
    }

    @Test
    @DisplayName("S3-SS-05 the marks of a timeline cannot be changed from outside")
    void timelineMarksAreCopied() {
        List<PhaseMark> source = new ArrayList<>(List.of(new PhaseMark(ExecutionPhase.CONNECT_STARTED, T0)));
        ExecutionTimeline timeline = new ExecutionTimeline(source);
        source.add(new PhaseMark(ExecutionPhase.CLOSED, T0));
        assertThat(timeline.marks()).hasSize(1);
        assertThatThrownBy(() -> timeline.marks().add(new PhaseMark(ExecutionPhase.CLOSED, T0))).isInstanceOf(RuntimeException.class);
    }

    @Test
    @DisplayName("S3-EX-03 a cancel source reports no request until it is cancelled, wakes a subscriber, and a second cancel changes nothing")
    void cancelSourceWakesSubscribers() {
        CancelSource source = new CancelSource();
        AtomicInteger woken = new AtomicInteger();
        source.whenRequested().thenRun(woken::incrementAndGet);
        assertThat(source.requested()).isFalse();
        assertThat(woken).hasValue(0);
        source.cancel();
        source.cancel();
        assertThat(source.requested()).isTrue();
        assertThat(woken).hasValue(1);
    }

    @Test
    @DisplayName("S3-EX-03 a subscriber that comes after the cancel is woken at once, and cannot cancel the source through its stage")
    void aLateSubscriberIsWokenAtOnce() {
        CancelSource source = new CancelSource();
        CompletableFuture<Void> subscriber = source.whenRequested().toCompletableFuture();
        subscriber.cancel(true);
        assertThat(source.requested()).isFalse();
        source.cancel();
        assertThat(source.whenRequested().toCompletableFuture()).isCompleted();
    }

    @Test
    @DisplayName("S3-SS-09 the guard of the execution control is called by the adapter and its refusal is an exception that passes")
    void theGuardRefusesByException() {
        AtomicInteger calls = new AtomicInteger();
        ExecutionControl allowing = new ExecutionControl(new CancelSource(), calls::incrementAndGet);
        allowing.guard().beforeDispatch();
        assertThat(calls).hasValue(1);
        ExecutionControl refusing = new ExecutionControl(new CancelSource(), () -> {
            throw new IllegalStateException("refused");
        });
        assertThatThrownBy(() -> refusing.guard().beforeDispatch()).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new ExecutionControl(null, calls::incrementAndGet)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new ExecutionControl(new CancelSource(), null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("S3-EX-05 a sink answers accepted or failed with its cause, and a failed result needs a cause")
    void sinkResultsAreClosed() {
        OutputSink sink = frame -> frame.data().length > 0 ? new SinkResult.Accepted() : new SinkResult.Failed(new IllegalStateException("empty"));
        assertThat(sink.accept(new StreamFrame(StreamKind.STDOUT, new byte[] {1}))).isInstanceOf(SinkResult.Accepted.class);
        SinkResult failed = sink.accept(new StreamFrame(StreamKind.STDERR, new byte[0]));
        assertThat(describe(failed)).isEqualTo("failed: empty");
        assertThatThrownBy(() -> new SinkResult.Failed(null)).isInstanceOf(NullPointerException.class);
    }

    private static String describe(SinkResult result) {
        return switch (result) {
            case SinkResult.Accepted accepted -> "accepted";
            case SinkResult.Failed failed -> "failed: " + failed.cause().getMessage();
        };
    }
}
