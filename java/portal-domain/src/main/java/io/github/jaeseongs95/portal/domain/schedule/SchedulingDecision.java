package io.github.jaeseongs95.portal.domain.schedule;

import io.github.jaeseongs95.portal.domain.id.OperationId;
import java.util.List;
import java.util.Objects;

/** What the scheduler decided for the queue as it is: claim one operation, expire some, wait because nothing waits, or wait because a limit is reached. */
public sealed interface SchedulingDecision permits SchedulingDecision.Claim, SchedulingDecision.ExpireQueued, SchedulingDecision.Idle, SchedulingDecision.Saturated {

    /** Claim this operation; the version is the one the decision was made against, so a change in between makes the claim fail instead of overriding it. */
    record Claim(OperationId id, long expectedVersion) implements SchedulingDecision {

        public Claim {
            Objects.requireNonNull(id, "id");
        }
    }

    /** These queued operations passed their deadline; expire them, then ask again. */
    record ExpireQueued(List<OperationId> ids) implements SchedulingDecision {

        public ExpireQueued {
            ids = List.copyOf(ids);
            if (ids.isEmpty()) {
                throw new IllegalArgumentException("Expire at least one operation");
            }
        }
    }

    /** Nothing waits. */
    record Idle() implements SchedulingDecision {
    }

    /** Operations wait, and none can start under the limits. */
    record Saturated(SaturationReason reason) implements SchedulingDecision {

        public Saturated {
            Objects.requireNonNull(reason, "reason");
        }
    }
}
