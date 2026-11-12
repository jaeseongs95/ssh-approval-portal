package io.github.jaeseongs95.portal.domain.operation;

import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import java.time.Instant;
import java.util.Objects;

/**
 * Every value of an {@link Operation}, as plain data: what the store writes and reads. {@link Operation#snapshot()} gives it and {@link Operation#restore} takes it
 * back and checks the invariants again, so the persistence mapper needs those two methods and nothing else (stage 2 design 13.3). The components are in the order of
 * design 2.7: first the contract, which never changes, then what the transitions change; {@code profile} and {@code audit} come last because the journal has them
 * as columns.
 *
 * <p>Not here: the position in the ready queue ({@code ready_sequence}) and the instants of becoming ready and of starting, which the store derives from the
 * events it writes ({@link Operation#event()}); the scheduler receives the position through a {@code QueuedOperation}.
 *
 * @param id the operation id
 * @param requestKey the caller's key
 * @param owner who owns the operation
 * @param targetId the target
 * @param targetRevision the revision of the target the operation is approved for
 * @param kind the kind, which is the kind of the input
 * @param input what to do
 * @param contractDigest the digest of the immutable contract
 * @param createdAt when it was accepted
 * @param expiry the deadline of the approval
 * @param conflictKey the resource it fences
 * @param state where it is
 * @param version the number of the last transition, starting at 1
 * @param updatedAt when the last transition happened
 * @param approvalMode who started it
 * @param decision the automatic approval's decision
 * @param settlement how it ended
 * @param recovery why a recovery changed it
 * @param cancellation whether a cancel was asked for while it ran
 * @param profile the connection profile it uses
 * @param audit whether its final audit record was written
 */
public record OperationSnapshot(OperationId id, RequestKey requestKey, OwnerId owner, TargetId targetId, TargetRevision targetRevision, OperationKind kind,
                                OperationInput input, Digest contractDigest, Instant createdAt, Deadline expiry, ConflictKey conflictKey, OperationState state,
                                long version, Instant updatedAt, ApprovalMode approvalMode, DecisionRecord decision, Settlement settlement, RecoveryReason recovery,
                                CancellationRequest cancellation, ProfileAlias profile, AuditState audit) {

    public OperationSnapshot {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(requestKey, "requestKey");
        Objects.requireNonNull(owner, "owner");
        Objects.requireNonNull(targetId, "targetId");
        Objects.requireNonNull(targetRevision, "targetRevision");
        Objects.requireNonNull(kind, "kind");
        Objects.requireNonNull(input, "input");
        Objects.requireNonNull(contractDigest, "contractDigest");
        Objects.requireNonNull(createdAt, "createdAt");
        Objects.requireNonNull(expiry, "expiry");
        Objects.requireNonNull(conflictKey, "conflictKey");
        Objects.requireNonNull(state, "state");
        Objects.requireNonNull(updatedAt, "updatedAt");
        Objects.requireNonNull(approvalMode, "approvalMode");
        Objects.requireNonNull(decision, "decision");
        Objects.requireNonNull(settlement, "settlement");
        Objects.requireNonNull(recovery, "recovery");
        Objects.requireNonNull(cancellation, "cancellation");
        Objects.requireNonNull(profile, "profile");
        Objects.requireNonNull(audit, "audit");
    }

    /** The same operation one transition later: the new state, version plus one, the instant of the transition. */
    OperationSnapshot advanced(OperationState next, Instant at) {
        return new OperationSnapshot(id, requestKey, owner, targetId, targetRevision, kind, input, contractDigest, createdAt, expiry, conflictKey, next, version + 1, at,
            approvalMode, decision, settlement, recovery, cancellation, profile, audit);
    }

    OperationSnapshot withApprovalMode(ApprovalMode mode) {
        return new OperationSnapshot(id, requestKey, owner, targetId, targetRevision, kind, input, contractDigest, createdAt, expiry, conflictKey, state, version,
            updatedAt, mode, decision, settlement, recovery, cancellation, profile, audit);
    }

    OperationSnapshot withDecision(DecisionRecord recorded) {
        return new OperationSnapshot(id, requestKey, owner, targetId, targetRevision, kind, input, contractDigest, createdAt, expiry, conflictKey, state, version,
            updatedAt, approvalMode, recorded, settlement, recovery, cancellation, profile, audit);
    }

    OperationSnapshot withSettlement(Settlement settled) {
        return new OperationSnapshot(id, requestKey, owner, targetId, targetRevision, kind, input, contractDigest, createdAt, expiry, conflictKey, state, version,
            updatedAt, approvalMode, decision, settled, recovery, cancellation, profile, audit);
    }

    OperationSnapshot withRecovery(RecoveryReason reason) {
        return new OperationSnapshot(id, requestKey, owner, targetId, targetRevision, kind, input, contractDigest, createdAt, expiry, conflictKey, state, version,
            updatedAt, approvalMode, decision, settlement, reason, cancellation, profile, audit);
    }

    OperationSnapshot withCancellation(CancellationRequest request) {
        return new OperationSnapshot(id, requestKey, owner, targetId, targetRevision, kind, input, contractDigest, createdAt, expiry, conflictKey, state, version,
            updatedAt, approvalMode, decision, settlement, recovery, request, profile, audit);
    }

    OperationSnapshot withAudit(AuditState auditState) {
        return new OperationSnapshot(id, requestKey, owner, targetId, targetRevision, kind, input, contractDigest, createdAt, expiry, conflictKey, state, version,
            updatedAt, approvalMode, decision, settlement, recovery, cancellation, profile, auditState);
    }
}
