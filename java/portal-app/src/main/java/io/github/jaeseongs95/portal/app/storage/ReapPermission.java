package io.github.jaeseongs95.portal.app.storage;

import java.util.Objects;

/** Whether expired bytes may be removed now: yes, or no and why. A reaper that is told "no" keeps every byte, row and charge as it is. */
public sealed interface ReapPermission permits ReapPermission.Allowed, ReapPermission.Suspended {

    record Allowed() implements ReapPermission {
    }

    /** The reap waits; nothing is deleted until the reason is gone. */
    record Suspended(SuspendReason reason) implements ReapPermission {

        public Suspended {
            Objects.requireNonNull(reason, "reason");
        }
    }

    /** Why a reap waits. */
    enum SuspendReason {
        /** A maintenance reservation holds the installation: the files and their accounting must stay as they are until it is released (RC-A-173). */
        MAINTENANCE,
        /** The protection of a file store failed: the portal must not delete what it cannot safely look at (RC-B-004). */
        PROTECTION_FAILED
    }
}
