package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

/**
 * What the owner of a remote request keeps in hand while the adapter runs it: the cancel and the last check before dispatch.
 *
 * @param cancel the owner's request to stop
 * @param guard the check the adapter makes after connecting and before it sends anything that changes the target
 */
public record ExecutionControl(CancelToken cancel, DispatchGuard guard) {

    public ExecutionControl {
        Objects.requireNonNull(cancel, "cancel");
        Objects.requireNonNull(guard, "guard");
    }
}
