package io.github.jaeseongs95.portal.domain.operation;

import java.time.Duration;
import java.time.Instant;
import java.util.Objects;

/**
 * The time after which an operation that has not been dispatched is no longer approved: none, or an instant. An approval is valid for one hour at most
 * (2.x ports.mjs APPROVAL_EXPIRES_MS), and a deadline a caller asks for has to lie after the moment of the request and within that hour (2.x approval-queue.mjs:56).
 */
public sealed interface Deadline permits Deadline.None, Deadline.At {

    /** How long an approval stays valid: one hour from the moment the request was accepted. */
    Duration APPROVAL_VALIDITY = Duration.ofHours(1);

    /** True when the moment is at or after the deadline. Nothing is reached when there is no deadline. */
    boolean isReached(Instant at);

    /** The deadline an operation accepted at {@code acceptedAt} gets: this one when it is valid, one hour later when it is none. */
    Deadline resolve(Instant acceptedAt);

    /** There is no deadline. */
    record None() implements Deadline {

        @Override
        public boolean isReached(Instant at) {
            return false;
        }

        @Override
        public Deadline resolve(Instant acceptedAt) {
            return new At(acceptedAt.plus(APPROVAL_VALIDITY));
        }
    }

    /** The deadline is an instant. */
    record At(Instant instant) implements Deadline {

        public At {
            Objects.requireNonNull(instant, "instant");
        }

        @Override
        public boolean isReached(Instant at) {
            return !at.isBefore(instant);
        }

        @Override
        public Deadline resolve(Instant acceptedAt) {
            if (!instant.isAfter(acceptedAt) || instant.isAfter(acceptedAt.plus(APPROVAL_VALIDITY))) {
                throw new IllegalArgumentException("Invalid approval deadline");
            }
            return this;
        }
    }
}
