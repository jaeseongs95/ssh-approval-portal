package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

/**
 * How a target is asked for elevated rights ({@code TargetPlatform#elevationPlan}), and so which adapter path serves an elevated request. The choice is a value
 * of this type, not an {@code if} on the operating system in the adapter (design patterns 8.12).
 */
public sealed interface ElevationPlan permits ElevationPlan.SudoNonInteractive, ElevationPlan.WindowsAdministratorCheck, ElevationPlan.NotSupported {

    /** A POSIX target: {@code sudo -n}; the probe is the fixed command that shows whether it is allowed without a password. */
    record SudoNonInteractive(FixedRemoteCommand probe) implements ElevationPlan {

        public SudoNonInteractive {
            Objects.requireNonNull(probe, "probe");
        }
    }

    /** A Windows target: the connection is already the administrator's or not; the probe is the fixed command that says which. */
    record WindowsAdministratorCheck(FixedRemoteCommand probe) implements ElevationPlan {

        public WindowsAdministratorCheck {
            Objects.requireNonNull(probe, "probe");
        }
    }

    /** The target has no elevation. */
    record NotSupported() implements ElevationPlan {
    }
}
