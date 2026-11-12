package io.github.jaeseongs95.portal.app.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.error.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;

/** Waiting for a change of an operation without polling (stage 3 design 8.2 group G2, cases A-142, A-146, A-148, A-154, B-193). */
class ChangeWaitersTest {

    private static final OperationId ID = new OperationId("a".repeat(48));
    private static final OperationId OTHER = new OperationId("b".repeat(48));

    private ThreadPoolTaskScheduler scheduler;

    @BeforeEach
    void startScheduler() {
        scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(1);
        scheduler.initialize();
    }

    @AfterEach
    void stopScheduler() {
        scheduler.shutdown();
    }

    private ChangeWaiters waiters(int observerCapacity) {
        ConcurrencyLimits limits = new ConcurrencyLimits(new Capacity(2), new Capacity(1), Map.of(), new Capacity(32), new Capacity(32), Map.of(),
            new ConcurrencyLimits.UnknownBudget.FollowsGlobal(), new Capacity(observerCapacity));
        return new ChangeWaiters(scheduler, limits, Clock.systemUTC());
    }

    @Test
    @DisplayName("RC-A-142 RC-B-196 a waiter is woken by the event of its operation with a newer version, and by no other event")
    void onlyANewerVersionOfTheSameOperationWakes() {
        ChangeWaiters waiters = waiters(4);
        CompletableFuture<WaitResult> waiting = waiters.await(ID, 2, Duration.ofSeconds(30), new CancelSource());
        waiters.changed(new OperationChanged(OTHER, OperationState.RUNNING, 9));
        waiters.changed(new OperationChanged(ID, OperationState.QUEUED, 2));
        assertThat(waiting).isNotDone();
        waiters.changed(new OperationChanged(ID, OperationState.RUNNING, 3));
        assertThat(waiting).isCompletedWithValue(new WaitResult.Changed(3));
        assertThat(waiters.waiting()).isZero();
    }

    @Test
    @DisplayName("RC-A-146 RC-A-155 when the time runs out first the wait ends as timed out, once, and the waiter is gone; a later event wakes nobody")
    void timeoutEndsTheWait() {
        ChangeWaiters waiters = waiters(4);
        CompletableFuture<WaitResult> waiting = waiters.await(ID, 2, Duration.ofMillis(30), new CancelSource());
        assertThat(waiting.join()).isEqualTo(new WaitResult.TimedOut());
        assertThat(waiters.waiting()).isZero();
        waiters.changed(new OperationChanged(ID, OperationState.COMPLETED, 5));
        assertThat(waiting.join()).isEqualTo(new WaitResult.TimedOut());
    }

    @Test
    @DisplayName("RC-B-193 RC-A-154 an abort ends only the wait with OPERATION_OBSERVER_ABORTED; the waiter is gone, and a change after the abort wakes nobody")
    void abortEndsOnlyTheWait() {
        ChangeWaiters waiters = waiters(4);
        CancelSource abort = new CancelSource();
        CompletableFuture<WaitResult> waiting = waiters.await(ID, 2, Duration.ofSeconds(30), abort);
        abort.cancel();
        Throwable failure = waiting.handle((value, error) -> error).join();
        assertThat(failure).isInstanceOfSatisfying(RequestRefusedException.class, e -> assertThat(e.code()).isEqualTo(OperationErrorCode.OPERATION_OBSERVER_ABORTED));
        assertThat(waiters.waiting()).isZero();
        waiters.changed(new OperationChanged(ID, OperationState.RUNNING, 3));
        assertThat(waiting).isCompletedExceptionally();
    }

    @Test
    @DisplayName("RC-A-148 as many waiters as the observer capacity may wait; the next is refused with OPERATION_OBSERVER_CAPACITY until one leaves")
    void waitersAreBounded() {
        ChangeWaiters waiters = waiters(2);
        CancelSource first = new CancelSource();
        waiters.await(ID, 1, Duration.ofSeconds(30), first);
        waiters.await(OTHER, 1, Duration.ofSeconds(30), new CancelSource());
        assertThatThrownBy(() -> waiters.await(ID, 1, Duration.ofSeconds(30), new CancelSource())).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(OperationErrorCode.OPERATION_OBSERVER_CAPACITY));
        first.cancel();
        assertThat(waiters.waiting()).isEqualTo(1);
        assertThat(waiters.await(ID, 1, Duration.ofSeconds(30), new CancelSource())).isNotDone();
    }

    @Test
    @DisplayName("RC-A-154 one event wakes every waiter of the operation that saw an older version, each exactly once")
    void oneEventWakesAllWaitersOnce() {
        ChangeWaiters waiters = waiters(4);
        CompletableFuture<WaitResult> early = waiters.await(ID, 1, Duration.ofSeconds(30), new CancelSource());
        CompletableFuture<WaitResult> current = waiters.await(ID, 3, Duration.ofSeconds(30), new CancelSource());
        waiters.changed(new OperationChanged(ID, OperationState.RUNNING, 3));
        assertThat(early).isCompletedWithValue(new WaitResult.Changed(3));
        assertThat(current).isNotDone();
        waiters.changed(new OperationChanged(ID, OperationState.COMPLETED, 4));
        assertThat(current).isCompletedWithValue(new WaitResult.Changed(4));
        assertThat(early).isCompletedWithValue(new WaitResult.Changed(3));
    }
}
