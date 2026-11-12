package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

/**
 * An elevation check: run the plan's probe on the target and say what it shows.
 *
 * @param target where to check
 * @param plan how the target is asked; a {@link ElevationPlan.NotSupported} plan is answered {@link ElevationResult.NotApplicable} without a connection
 * @param limits the deadline, the stop grace and the output cap of the probe
 */
public record ElevationRequest(RemoteTarget target, ElevationPlan plan, ExecutionLimits limits) {

    public ElevationRequest {
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(plan, "plan");
        Objects.requireNonNull(limits, "limits");
    }
}
