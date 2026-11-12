package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

/**
 * With which rights a file operation runs: the rights of the profile's account, or elevated by a plan the target supports. An elevated access cannot be built from a
 * target that has no elevation: that is refused by the caller that reads the target's capabilities, not left to the adapter.
 */
public sealed interface FileAccess permits FileAccess.Direct, FileAccess.Elevated {

    /** The rights of the account the profile logs in with. */
    record Direct() implements FileAccess {
    }

    /** Elevated rights, reached the way the plan says. */
    record Elevated(ElevationPlan plan) implements FileAccess {

        public Elevated {
            Objects.requireNonNull(plan, "plan");
            if (plan instanceof ElevationPlan.NotSupported) {
                throw new IllegalArgumentException("An elevated access needs a plan the target supports");
            }
        }
    }
}
