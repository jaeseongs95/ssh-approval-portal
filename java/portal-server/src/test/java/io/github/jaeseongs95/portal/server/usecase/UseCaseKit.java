package io.github.jaeseongs95.portal.server.usecase;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Predicate;

import io.github.jaeseongs95.portal.app.event.ChangeWaiters;
import io.github.jaeseongs95.portal.app.event.WaitResult;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.operation.CommandInput;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;

/** What every use case test needs: operations for the test target with a key of their own, and a wait for a state that is driven by the events of the operation, not by a poll. */
final class UseCaseKit {

    private final Digester digester;
    private final FixedTargets targets;
    private final ChangeWaiters waiters;
    private final OperationJournal journal;
    private final AtomicInteger counter = new AtomicInteger();

    UseCaseKit(Digester digester, FixedTargets targets, ChangeWaiters waiters, OperationJournal journal) {
        this.digester = digester;
        this.targets = targets;
        this.waiters = waiters;
        this.journal = journal;
    }

    /** A command operation for the write profile of the test target, with a key that no other test uses. */
    NewOperation command(String text) {
        return command(newKey(), text, FixedTargets.WRITE_PROFILE, new Deadline.None());
    }

    NewOperation command(RequestKey key, String text) {
        return command(key, text, FixedTargets.WRITE_PROFILE, new Deadline.None());
    }

    NewOperation command(String text, Deadline expiry) {
        return command(newKey(), text, FixedTargets.WRITE_PROFILE, expiry);
    }

    NewOperation command(RequestKey key, String text, ProfileAlias profile, Deadline expiry) {
        return NewOperation.of(digester, key, new OwnerId("owner"), FixedTargets.ID, targets.current().revision(), profile,
            new CommandInput(new CommandText(text), new Utf8Text("caller"), new Utf8Text("display")), new ConflictKey.None(), expiry);
    }

    RequestKey newKey() {
        return new RequestKey("req-" + counter.incrementAndGet() + "-" + UUID.randomUUID());
    }

    Operation find(OperationId id) {
        return journal.find(id).orElseThrow();
    }

    /**
     * Waits, by the events of the operation (the change waiters of the use cases; no poll), until the operation satisfies the test, and returns it. Fails the test after 20
     * seconds. It does not look at the target, so it also waits for an operation whose target was changed.
     */
    Operation await(OperationId id, Predicate<Operation> done) throws Exception {
        Instant until = Instant.now().plusSeconds(20);
        Operation current = find(id);
        while (!done.test(current)) {
            if (Instant.now().isAfter(until)) {
                throw new AssertionError("The operation did not reach the expected state in time; it is " + current.state());
            }
            CompletableFuture<WaitResult> pending = waiters.await(id, current.version(), Duration.ofSeconds(2), new CancelSource());
            Operation again = find(id);
            if (again.version() == current.version()) {
                pending.get(10, TimeUnit.SECONDS);
                again = find(id);
            } else {
                pending.cancel(false);
            }
            current = again;
        }
        return current;
    }

    /** Waits until the operation is in a terminal state. */
    Operation awaitTerminal(OperationId id) throws Exception {
        return await(id, operation -> operation.state().isTerminal());
    }
}
