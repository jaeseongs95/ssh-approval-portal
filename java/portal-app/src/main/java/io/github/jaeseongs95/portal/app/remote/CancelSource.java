package io.github.jaeseongs95.portal.app.remote;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/**
 * The {@link CancelToken} the use case holds and the owner's cancel writes to. {@link #cancel()} may be called any number of times from any thread; the first call
 * wakes everyone who subscribed, the later ones change nothing. A source nobody cancels is the token of a request that is never stopped.
 */
public final class CancelSource implements CancelToken {

    private final CompletableFuture<Void> requested = new CompletableFuture<>();

    /** Asks to stop. */
    public void cancel() {
        requested.complete(null);
    }

    @Override
    public boolean requested() {
        return requested.isDone();
    }

    /** A copy of the future, so a subscriber cannot complete the source itself. */
    @Override
    public CompletionStage<Void> whenRequested() {
        return requested.copy();
    }
}
