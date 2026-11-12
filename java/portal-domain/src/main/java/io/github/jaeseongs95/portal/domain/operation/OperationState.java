package io.github.jaeseongs95.portal.domain.operation;

import com.fasterxml.jackson.annotation.JsonValue;
import java.util.Locale;

/**
 * Where an operation is in its life. One type has all thirteen states (stage 2 design 2.1): 2.x kept the durable eleven in the journal and the other two
 * ({@code pending}, {@code evaluating}) in the memory of the approval queue, and the two disagreed (defect D-0004). The wire value is the lowercase name, the order
 * is the contract's ({@code public-contract.mjs:15}); the database column holds the name.
 *
 * <p>{@link #canMoveTo(OperationState)} is the one table of allowed moves (design 2.3, transitions T1 to T25 without the initial one). {@link Operation} checks it
 * for every transition and adds the conditions a table cannot state (a deadline, an authority, an outcome).
 */
public enum OperationState {
    /** The intent is stored; it has not reached the approval step. A new operation is accepted and moves on in the same transaction, so nobody observes this. */
    ACCEPTED,
    /** Waiting for the owner's decision. */
    PENDING,
    /** The automatic approval is being evaluated. */
    EVALUATING,
    /** Approved and waiting in the execution queue. */
    QUEUED,
    /** Claimed; the external effect has not begun. */
    STARTING,
    RUNNING,
    /** A cancel was requested and the stop is not confirmed. */
    TERMINATING,
    COMPLETED,
    FAILED,
    CANCELLED,
    DENIED,
    EXPIRED,
    /** The result is not certain and has to be reconciled; nothing runs again by itself. */
    UNKNOWN;

    /** True when the operation may move from this state to {@code to}. A final state moves nowhere; {@link #UNKNOWN} moves only to a confirmed result. */
    public boolean canMoveTo(OperationState to) {
        return switch (this) {
            case ACCEPTED -> to == EVALUATING || to == PENDING || to == EXPIRED || to == CANCELLED || to == UNKNOWN;
            case EVALUATING -> to == PENDING || to == DENIED || to == EXPIRED || to == CANCELLED || to == UNKNOWN;
            case PENDING -> to == QUEUED || to == DENIED || to == EXPIRED || to == CANCELLED || to == FAILED;
            case QUEUED -> to == STARTING || to == DENIED || to == EXPIRED || to == CANCELLED || to == FAILED || to == UNKNOWN;
            case STARTING -> to == RUNNING || to == TERMINATING || to == COMPLETED || to == FAILED || to == CANCELLED || to == EXPIRED || to == UNKNOWN;
            case RUNNING -> to == TERMINATING || to == COMPLETED || to == FAILED || to == CANCELLED || to == UNKNOWN;
            case TERMINATING -> to == COMPLETED || to == FAILED || to == CANCELLED || to == UNKNOWN;
            case UNKNOWN -> to == COMPLETED || to == FAILED || to == CANCELLED;
            case COMPLETED, FAILED, CANCELLED, DENIED, EXPIRED -> false;
        };
    }

    /** True for the six states the operation does not leave by itself: the five final states and {@link #UNKNOWN} (2.x operation-store.mjs:8). */
    public boolean isTerminal() {
        return switch (this) {
            case COMPLETED, FAILED, CANCELLED, DENIED, EXPIRED, UNKNOWN -> true;
            case ACCEPTED, PENDING, EVALUATING, QUEUED, STARTING, RUNNING, TERMINATING -> false;
        };
    }

    /** True for the five final states: nothing moves out of them. {@link #UNKNOWN} is terminal but not final. */
    public boolean isFinal() {
        return isTerminal() && this != UNKNOWN;
    }

    /** True while the operation holds an execution slot: starting, running, terminating (2.x operation-store.mjs:9). */
    public boolean isActive() {
        return switch (this) {
            case STARTING, RUNNING, TERMINATING -> true;
            case ACCEPTED, PENDING, EVALUATING, QUEUED, COMPLETED, FAILED, CANCELLED, DENIED, EXPIRED, UNKNOWN -> false;
        };
    }

    /** True before the external effect: expiry, denial and cancellation are still certain there. */
    public boolean isPreDispatch() {
        return switch (this) {
            case ACCEPTED, EVALUATING, PENDING, QUEUED -> true;
            case STARTING, RUNNING, TERMINATING, COMPLETED, FAILED, CANCELLED, DENIED, EXPIRED, UNKNOWN -> false;
        };
    }

    @JsonValue
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }
}
