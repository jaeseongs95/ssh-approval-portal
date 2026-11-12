package io.github.jaeseongs95.portal.app.remote;

import java.util.concurrent.CompletionStage;

/**
 * The owner's request to stop a remote request. The adapter never polls it: it reads {@link #requested()} at its checkpoints and subscribes to
 * {@link #whenRequested()} to be woken while it waits on the network (no {@code Thread.sleep}, no loop). A cancel is a request, not proof that the remote work
 * ended; the result of the adapter says what is known.
 */
public interface CancelToken {

    /** True once the owner asked to stop. */
    boolean requested();

    /** A stage that completes (with no value) when the owner asks to stop, at once if it already did. */
    CompletionStage<Void> whenRequested();
}
