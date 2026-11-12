package io.github.jaeseongs95.portal.app.journal;

import java.time.Instant;

import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;

/**
 * The claim of a queued operation by the dispatcher (2.x {@code operation-store.mjs:248-259}, {@code BEGIN IMMEDIATE}).
 *
 * <p>The limits are kept by primary keys, not by a transaction isolation level (design 13.2): the global and the per-target concurrency are the rows
 * {@code operation_slot (scope, slot_no)}, the conflict key is the row {@code operation_fence}. A claim inserts the smallest free slot of each scope and moves the
 * operation to {@code STARTING} in one transaction, so two claims that want the same slot collide on the key and one of them answers {@link ClaimResult.Contended}.
 * The default isolation level is used; SERIALIZABLE is not declared because its behaviour differs between database systems.
 *
 * <p>The unknown budget is only a loose upper bound: the count of {@code UNKNOWN} operations is read in the same transaction, but settling an operation as
 * {@code UNKNOWN} is a fact that cannot be refused, so two racing claims may see the same count and the budget may be exceeded by one. This is intended
 * (design 13.2) and pinned by test S2-DB-05.
 */
public interface ClaimStore {

    ClaimResult claim(OperationId id, long expectedVersion, ConcurrencyLimits limits, Instant at);
}
