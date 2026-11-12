package io.github.jaeseongs95.portal.app.event;

/** How a wait for a change of an operation ended: the operation changed, or the time ran out first. An abort is not a result but a refusal (the future fails). */
public sealed interface WaitResult permits WaitResult.Changed, WaitResult.TimedOut {

    /**
     * The operation reached a newer version than the waiter saw.
     *
     * @param version the version it reached
     */
    record Changed(long version) implements WaitResult {
    }

    /** The time ran out and nothing changed. */
    record TimedOut() implements WaitResult {
    }
}
