package io.github.jaeseongs95.portal.app.admission;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Clock;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.error.CapacityErrorCode;
import io.github.jaeseongs95.portal.domain.error.ErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.schedule.AdmissionLimits;

/** The entrance of the requests (stage 3 design 8.2 group G6): cases B-372 to B-378. */
class RequestAdmissionTest {

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

    private RequestAdmission entrance(int maxActive, int maxQueued, Duration maxWait, int maxDetached) {
        return new RequestAdmission(new AdmissionLimits(new Capacity(maxActive), maxQueued, maxWait, maxDetached), scheduler, Clock.systemUTC());
    }

    private static AdmissionTicket granted(CompletionStage<AdmissionTicket> stage) {
        assertThat(stage.toCompletableFuture()).isDone();
        return stage.toCompletableFuture().join();
    }

    private static ErrorCode refusedWith(CompletionStage<?> stage) {
        CompletableFuture<?> future = stage.toCompletableFuture();
        future.handle((value, error) -> null).join();
        assertThat(future).isCompletedExceptionally();
        Throwable failure = future.exceptionNow();
        assertThat(failure).isInstanceOf(RequestRefusedException.class);
        return ((RequestRefusedException) failure).code();
    }

    @Test
    @DisplayName("RC-B-372 the default limits are 8 active, 32 queued, 5 seconds of waiting and 64 detached; an invalid limit is refused when it is built")
    void defaultsAndInvalidLimits() {
        AdmissionLimits defaults = AdmissionLimits.defaults();
        assertThat(defaults.maxActive().value()).isEqualTo(8);
        assertThat(defaults.maxQueued()).isEqualTo(32);
        assertThat(defaults.maxWait()).isEqualTo(Duration.ofMillis(5000));
        assertThat(defaults.maxDetached()).isEqualTo(64);
        assertThat(new RequestAdmission(defaults, scheduler, Clock.systemUTC()).snapshot()).isEqualTo(new AdmissionSnapshot(0, 0, 0, false));
        assertThatThrownBy(() -> new Capacity(0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AdmissionLimits(new Capacity(1), -1, Duration.ofSeconds(1), 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AdmissionLimits(new Capacity(1), 0, Duration.ZERO, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AdmissionLimits(new Capacity(1), 0, Duration.ofMillis(Integer.MAX_VALUE + 1L), 0)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("RC-B-373 the waiters are served in the order they came, a newcomer does not pass them, a full line refuses, and release is idempotent")
    void firstComeFirstServed() {
        RequestAdmission entrance = entrance(1, 2, Duration.ofSeconds(30), 1);
        AdmissionTicket first = granted(entrance.acquire(new CancelSource()));
        CompletionStage<AdmissionTicket> second = entrance.acquire(new CancelSource());
        CompletionStage<AdmissionTicket> third = entrance.acquire(new CancelSource());
        CompletionStage<AdmissionTicket> fourth = entrance.acquire(new CancelSource());
        assertThat(refusedWith(fourth)).isEqualTo(CapacityErrorCode.REQUEST_QUEUE_FULL);
        assertThat(entrance.snapshot()).isEqualTo(new AdmissionSnapshot(1, 2, 0, false));
        first.release();
        first.release();
        assertThat(second.toCompletableFuture()).isDone();
        assertThat(third.toCompletableFuture()).isNotDone();
        assertThat(entrance.snapshot()).isEqualTo(new AdmissionSnapshot(1, 1, 0, false));
        second.toCompletableFuture().join().release();
        assertThat(third.toCompletableFuture()).isDone();
        third.toCompletableFuture().join().release();
        assertThat(entrance.snapshot()).isEqualTo(new AdmissionSnapshot(0, 0, 0, false));
    }

    @Test
    @DisplayName("RC-B-374 a waiter that is cancelled leaves the line with REQUEST_ABORTED, an already cancelled request is refused, and a granted request keeps its place when it is cancelled")
    void cancelOfWaitersAndOwners() {
        RequestAdmission entrance = entrance(1, 2, Duration.ofSeconds(30), 1);
        CancelSource ownerCancel = new CancelSource();
        AdmissionTicket owner = granted(entrance.acquire(ownerCancel));
        CancelSource waiterCancel = new CancelSource();
        CompletionStage<AdmissionTicket> waiter = entrance.acquire(waiterCancel);
        waiterCancel.cancel();
        assertThat(refusedWith(waiter)).isEqualTo(CapacityErrorCode.REQUEST_ABORTED);
        CancelSource already = new CancelSource();
        already.cancel();
        assertThat(refusedWith(entrance.acquire(already))).isEqualTo(CapacityErrorCode.REQUEST_ABORTED);
        ownerCancel.cancel();
        assertThat(entrance.snapshot()).isEqualTo(new AdmissionSnapshot(1, 0, 0, false));
        CancelSource late = new CancelSource();
        CompletionStage<AdmissionTicket> promoted = entrance.acquire(late);
        owner.release();
        assertThat(promoted.toCompletableFuture()).isDone();
        late.cancel();
        assertThat(entrance.snapshot()).isEqualTo(new AdmissionSnapshot(1, 0, 0, false));
        promoted.toCompletableFuture().join().release();
        promoted.toCompletableFuture().join().release();
        assertThat(entrance.snapshot()).isEqualTo(new AdmissionSnapshot(0, 0, 0, false));
    }

    @Test
    @DisplayName("RC-B-375 a waiter whose time is up is refused with REQUEST_QUEUE_TIMEOUT, leaves the line, and the holder keeps its place")
    void waitingTimesOut() {
        RequestAdmission entrance = entrance(1, 2, Duration.ofMillis(50), 1);
        AdmissionTicket holder = granted(entrance.acquire(new CancelSource()));
        assertThat(refusedWith(entrance.acquire(new CancelSource()))).isEqualTo(CapacityErrorCode.REQUEST_QUEUE_TIMEOUT);
        assertThat(entrance.snapshot()).isEqualTo(new AdmissionSnapshot(1, 0, 0, false));
        holder.release();
        assertThat(granted(entrance.acquire(new CancelSource()))).isNotNull();
    }

    @Test
    @DisplayName("RC-B-376 a detached request frees its place for the next waiter, detach is idempotent, the detached limit is REQUEST_WAIT_LIMIT, and release gives the count back")
    void detach() {
        RequestAdmission entrance = entrance(1, 1, Duration.ofSeconds(30), 1);
        AdmissionTicket first = granted(entrance.acquire(new CancelSource()));
        CompletionStage<AdmissionTicket> second = entrance.acquire(new CancelSource());
        first.detach();
        first.detach();
        assertThat(entrance.snapshot()).isEqualTo(new AdmissionSnapshot(1, 0, 1, false));
        AdmissionTicket promoted = second.toCompletableFuture().join();
        assertThatThrownBy(promoted::detach).isInstanceOfSatisfying(RequestRefusedException.class, e -> assertThat(e.code()).isEqualTo(CapacityErrorCode.REQUEST_WAIT_LIMIT));
        assertThat(entrance.snapshot()).isEqualTo(new AdmissionSnapshot(1, 0, 1, false));
        first.release();
        first.release();
        assertThat(entrance.snapshot()).isEqualTo(new AdmissionSnapshot(1, 0, 0, false));
        promoted.detach();
        assertThat(entrance.snapshot()).isEqualTo(new AdmissionSnapshot(0, 0, 1, false));
        promoted.release();
        assertThat(entrance.snapshot()).isEqualTo(new AdmissionSnapshot(0, 0, 0, false));
    }

    @Test
    @DisplayName("RC-B-377 a closed entrance refuses the waiters and every later request with REQUEST_QUEUE_CLOSED, and the owners keep their places until they release")
    void close() {
        RequestAdmission entrance = entrance(1, 2, Duration.ofSeconds(30), 1);
        AdmissionTicket owner = granted(entrance.acquire(new CancelSource()));
        CompletionStage<AdmissionTicket> waiter = entrance.acquire(new CancelSource());
        entrance.close();
        entrance.close();
        assertThat(refusedWith(waiter)).isEqualTo(CapacityErrorCode.REQUEST_QUEUE_CLOSED);
        assertThat(refusedWith(entrance.acquire(new CancelSource()))).isEqualTo(CapacityErrorCode.REQUEST_QUEUE_CLOSED);
        assertThatThrownBy(owner::detach).isInstanceOfSatisfying(RequestRefusedException.class, e -> assertThat(e.code()).isEqualTo(CapacityErrorCode.REQUEST_QUEUE_CLOSED));
        assertThat(entrance.snapshot()).isEqualTo(new AdmissionSnapshot(1, 0, 0, true));
        owner.release();
        assertThat(entrance.snapshot()).isEqualTo(new AdmissionSnapshot(0, 0, 0, true));
    }

    @Test
    @DisplayName("RC-B-378 with no queue and no detach room a full entrance refuses at once with REQUEST_QUEUE_FULL and detach with REQUEST_WAIT_LIMIT")
    void zeroQueueAndZeroDetach() {
        RequestAdmission entrance = entrance(2, 0, Duration.ofSeconds(30), 0);
        AdmissionTicket first = granted(entrance.acquire(new CancelSource()));
        AdmissionTicket second = granted(entrance.acquire(new CancelSource()));
        assertThat(refusedWith(entrance.acquire(new CancelSource()))).isEqualTo(CapacityErrorCode.REQUEST_QUEUE_FULL);
        assertThatThrownBy(first::detach).isInstanceOfSatisfying(RequestRefusedException.class, e -> assertThat(e.code()).isEqualTo(CapacityErrorCode.REQUEST_WAIT_LIMIT));
        assertThat(entrance.snapshot()).isEqualTo(new AdmissionSnapshot(2, 0, 0, false));
        first.release();
        assertThat(entrance.snapshot().active()).isEqualTo(1);
        second.release();
        assertThat(entrance.snapshot().active()).isZero();
    }
}
