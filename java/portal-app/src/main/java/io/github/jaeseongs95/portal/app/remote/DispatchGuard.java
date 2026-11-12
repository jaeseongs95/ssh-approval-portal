package io.github.jaeseongs95.portal.app.remote;

/**
 * The last check before a request that changes something is written to the target: the use case asks again whether the target, its revision and the policy are
 * still what the operation was approved for. The adapter calls it after the connection is open and before the {@code exec} or the first write, so a target that
 * was changed while the connection was being made is never reached with the old approval.
 *
 * <p>A refusal is a {@code DispatchRefusedException} (reason {@code target_changed}, {@code policy_changed} and the like); the adapter lets it pass after it has
 * closed what it opened. Nothing has been sent when it is thrown.
 */
@FunctionalInterface
public interface DispatchGuard {

    /** Returns when the dispatch is still allowed, throws {@code DispatchRefusedException} when it is not. */
    void beforeDispatch();
}
