package io.github.jaeseongs95.portal.ssh.testkit;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * An append-only log of events a test server records (exec requests, signals, authentication attempts ...). A test waits for "at least n events" with
 * {@link #whenAtLeast(int)} or {@link #await(int, Duration)}: both are event waits (a {@link CompletableFuture} completed by the recording thread), no polling and no sleep.
 *
 * @param <T> the event type; events are never null
 */
public final class EventLog<T> {

    private record Waiter<E>(int count, CompletableFuture<List<E>> future) {
    }

    private final List<T> items = new ArrayList<>();
    private final List<Waiter<T>> waiters = new ArrayList<>();

    /** Records one event and completes the waiters whose count is reached. Called by the test server only. */
    void add(T item) {
        List<Waiter<T>> ready = new ArrayList<>();
        List<T> copy;
        synchronized (this) {
            items.add(item);
            copy = List.copyOf(items);
            for (Iterator<Waiter<T>> iterator = waiters.iterator(); iterator.hasNext();) {
                Waiter<T> waiter = iterator.next();
                if (waiter.count() <= items.size()) {
                    ready.add(waiter);
                    iterator.remove();
                }
            }
        }
        // Outside the lock: a completion callback of a waiter may read this log again.
        ready.forEach(waiter -> waiter.future().complete(copy));
    }

    /** The events recorded so far, oldest first. */
    public synchronized List<T> snapshot() {
        return List.copyOf(items);
    }

    /** The number of events recorded so far. */
    public synchronized int size() {
        return items.size();
    }

    /** A future that completes with the events (oldest first) as soon as at least {@code count} events exist; already complete if they do. */
    public CompletableFuture<List<T>> whenAtLeast(int count) {
        synchronized (this) {
            if (items.size() >= count) {
                return CompletableFuture.completedFuture(List.copyOf(items));
            }
            CompletableFuture<List<T>> future = new CompletableFuture<>();
            waiters.add(new Waiter<>(count, future));
            return future;
        }
    }

    /** Waits (without polling) until at least {@code count} events exist or the limit passes; the {@link TimeoutException} says how many events were seen. */
    public List<T> await(int count, Duration limit) throws InterruptedException, TimeoutException {
        try {
            return whenAtLeast(count).get(limit.toNanos(), TimeUnit.NANOSECONDS);
        } catch (ExecutionException e) {
            throw new IllegalStateException("an event log future never fails, but it did", e);
        } catch (TimeoutException e) {
            throw new TimeoutException("expected at least " + count + " events within " + limit + ", saw " + size() + ": " + snapshot());
        }
    }
}
