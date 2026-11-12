package io.github.jaeseongs95.portal.app.storage;

import java.util.Objects;

/** What a reap run did: it removed what had expired (and left what it could not remove), or it did nothing because the {@link ReapGate} said to wait. */
public sealed interface ReapReport permits ReapReport.Reaped, ReapReport.Suspended {

    /**
     * The run happened.
     *
     * @param removed how many expired items were removed with their bytes and their charge
     * @param failed how many could not be removed and stay until the next run
     */
    record Reaped(int removed, int failed) implements ReapReport {

        public Reaped {
            if (removed < 0 || failed < 0) {
                throw new IllegalArgumentException("The counts must not be negative");
            }
        }
    }

    /** The run did not happen; every byte, row and charge is as it was. */
    record Suspended(ReapPermission.SuspendReason reason) implements ReapReport {

        public Suspended {
            Objects.requireNonNull(reason, "reason");
        }
    }
}
