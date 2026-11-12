package io.github.jaeseongs95.portal.domain.approval;

import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.operation.StateCounts;
import java.util.Objects;

/**
 * The rules of the maintenance reservation: when the bridge may be reserved, and what happens to an operation that waits in the queue at that moment. Maintenance
 * is for work on the bridge itself (an upgrade, a backup), so it needs a quiet bridge: no request may be open (2.x approval-queue.mjs:97-99).
 */
public final class MaintenancePolicy {

    /** Whether the bridge may be reserved now; a refusal says why. */
    public ReservationDecision canReserve(MaintenanceState current, StateCounts counts) {
        Objects.requireNonNull(current, "current");
        Objects.requireNonNull(counts, "counts");
        return switch (current) {
            case MaintenanceState.Reserved reserved -> new ReservationDecision.Refused(ReservationRefusal.ALREADY_RESERVED);
            case MaintenanceState.Open open -> counts.open() > 0
                ? new ReservationDecision.Refused(ReservationRefusal.REQUESTS_OPEN) : new ReservationDecision.Allowed();
        };
    }

    /** The failure a queued operation gets when maintenance begins while it waits: refused before dispatch, for maintenance (2.x approval-queue.mjs:32-37). */
    public DispatchFailure failureForQueuedOperation() {
        return DispatchFailure.refused(DispatchReason.MAINTENANCE, DispatchStage.MAINTENANCE);
    }

    /** Whether a reservation is allowed. */
    public sealed interface ReservationDecision permits ReservationDecision.Allowed, ReservationDecision.Refused {

        /** The bridge may be reserved. */
        record Allowed() implements ReservationDecision {
        }

        /** The bridge may not be reserved. */
        record Refused(ReservationRefusal reason) implements ReservationDecision {

            public Refused {
                Objects.requireNonNull(reason, "reason");
            }
        }
    }

    /** Why a reservation was refused. */
    public enum ReservationRefusal {
        /** Another reservation exists. */
        ALREADY_RESERVED,
        /** Requests are still open: pending, evaluating, queued or running. They must finish first. */
        REQUESTS_OPEN
    }
}
