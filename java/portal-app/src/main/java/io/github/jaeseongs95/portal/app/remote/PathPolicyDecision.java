package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.path.RemotePath;

/**
 * What the file path policy says about a path on a target: stay inside a root, the root rule is lifted for this target (the test-server mode), the policy does not
 * apply to this target, or it could not be decided. The last one is a refusal ({@code PATH_POLICY_UNSUPPORTED}), never an allowance.
 */
public sealed interface PathPolicyDecision permits PathPolicyDecision.Enforce, PathPolicyDecision.Bypass, PathPolicyDecision.NotApplicable,
    PathPolicyDecision.Unconfirmed {

    /** The path has to lie inside the root; outside it is {@code PATH_OUTSIDE_ALLOWED_ROOT}. */
    record Enforce(RemotePath allowedRoot) implements PathPolicyDecision {

        public Enforce {
            Objects.requireNonNull(allowedRoot, "allowedRoot");
        }
    }

    /** The root rule does not apply to this target. */
    record Bypass() implements PathPolicyDecision {
    }

    /** The target has no root rule. */
    record NotApplicable() implements PathPolicyDecision {
    }

    /** The policy could not be established. */
    record Unconfirmed() implements PathPolicyDecision {
    }
}
