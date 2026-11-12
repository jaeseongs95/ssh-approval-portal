package io.github.jaeseongs95.portal.domain.operation;

import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
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
 * One operation, from the request to the end, in one type. It holds all thirteen states and every transition is a method that returns the next operation; the
 * object itself never changes. A transition the state table does not allow (or whose condition does not hold) throws a {@link RequestRefusedException} with the
 * code {@code INVALID_OPERATION_TRANSITION}, and nothing is changed. Every transition adds one to the version and the store writes one event for it.
 *
 * <p>The rules this type keeps, from the stage 2 design 2.6:
 * <ul>
 *   <li>A completed result needs {@link CompletionEvidence} that confirms it; without it the outcome is unknown, never completed (defect D-0035).
 *   <li>An unknown operation is never replayed: it moves only to a reconciled result, through {@link #reconcile}.
 *   <li>The contract (owner, target, revision, kind, input, conflict key, deadline) never changes after {@link #accept}.
 *   <li>Time is an argument. A use case reads the clock once and passes the same instant to every transition it makes.
 * </ul>
 *
 * <p>The persistence side needs {@link #snapshot()} and {@link #restore(OperationSnapshot)} only.
 */
public final class Operation {

    private final OperationSnapshot snapshot;

    private Operation(OperationSnapshot snapshot) {
        this.snapshot = snapshot;
    }

    /**
     * Accepts a request: version 1, state {@code ACCEPTED}. A use case moves it on in the same transaction ({@link #beginEvaluation} or {@link #awaitOwnerDecision}),
     * so an observer never sees {@code accepted}. The deadline is the one the caller asked for, which has to lie after {@code at} and within one hour of it, or one
     * hour after {@code at} when the caller asked for none.
     */
    public static Operation accept(NewOperation spec, OperationId id, Instant at) {
        Objects.requireNonNull(spec, "spec");
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(at, "at");
        Deadline expiry = spec.requestedExpiry().resolve(at);
        return new Operation(new OperationSnapshot(id, spec.requestKey(), spec.owner(), spec.targetId(), spec.targetRevision(), spec.kind(), spec.input(),
            spec.contractDigest(), at, expiry, spec.conflictKey(), OperationState.ACCEPTED, 1L, at, ApprovalMode.NOT_DECIDED, new DecisionRecord.NoDecision(),
            new Settlement.Unsettled(), RecoveryReason.NONE, new CancellationRequest.NotRequested(), spec.profile(), AuditState.NONE));
    }

    /** Takes a stored operation back and checks its invariants again; a stored record that breaks one is refused as {@code INVALID_OPERATION_RECORD}. */
    public static Operation restore(OperationSnapshot snapshot) {
        Objects.requireNonNull(snapshot, "snapshot");
        try {
            requireValid(snapshot);
        } catch (IllegalArgumentException e) {
            throw new RequestRefusedException(OperationErrorCode.INVALID_OPERATION_RECORD, e);
        }
        return new Operation(snapshot);
    }

    private static void requireValid(OperationSnapshot s) {
        if (s.version() < 1) {
            throw new IllegalArgumentException("The version starts at 1");
        }
        if (s.kind() != s.input().kind()) {
            throw new IllegalArgumentException("The kind is not the kind of the input");
        }
        if (s.updatedAt().isBefore(s.createdAt())) {
            throw new IllegalArgumentException("The operation was updated before it was created");
        }
        if ((s.settlement() instanceof Settlement.Settled) != s.state().isTerminal()) {
            throw new IllegalArgumentException("A settlement exists exactly when the state is terminal");
        }
        if (s.settlement() instanceof Settlement.Settled settled && (settled.certainty() == OutcomeCertainty.UNKNOWN) != (s.state() == OperationState.UNKNOWN)) {
            throw new IllegalArgumentException("The outcome is unknown exactly when the state is unknown");
        }
        boolean decided = s.approvalMode() != ApprovalMode.NOT_DECIDED;
        switch (s.state()) {
            case ACCEPTED, EVALUATING, PENDING -> {
                if (decided) {
                    throw new IllegalArgumentException("An operation that is not yet approved has no approval mode");
                }
            }
            case QUEUED, STARTING, RUNNING, TERMINATING -> {
                if (!decided) {
                    throw new IllegalArgumentException("An approved operation has an approval mode");
                }
            }
            case COMPLETED, FAILED, CANCELLED, DENIED, EXPIRED, UNKNOWN -> {
                // Any mode: the operation was approved or ended before it was.
            }
        }
        if (s.state() == OperationState.TERMINATING && !(s.cancellation() instanceof CancellationRequest.RequestedAt)) {
            throw new IllegalArgumentException("A terminating operation has a recorded cancel request");
        }
    }

    /** Every value of the operation, for the store. */
    public OperationSnapshot snapshot() {
        return snapshot;
    }

    public OperationId id() {
        return snapshot.id();
    }

    public RequestKey requestKey() {
        return snapshot.requestKey();
    }

    public OwnerId owner() {
        return snapshot.owner();
    }

    public TargetId targetId() {
        return snapshot.targetId();
    }

    public TargetRevision targetRevision() {
        return snapshot.targetRevision();
    }

    public OperationKind kind() {
        return snapshot.kind();
    }

    public OperationInput input() {
        return snapshot.input();
    }

    public Digest contractDigest() {
        return snapshot.contractDigest();
    }

    public Instant createdAt() {
        return snapshot.createdAt();
    }

    public Deadline expiry() {
        return snapshot.expiry();
    }

    public ConflictKey conflictKey() {
        return snapshot.conflictKey();
    }

    public OperationState state() {
        return snapshot.state();
    }

    public long version() {
        return snapshot.version();
    }

    public Instant updatedAt() {
        return snapshot.updatedAt();
    }

    public ApprovalMode approvalMode() {
        return snapshot.approvalMode();
    }

    public DecisionRecord decision() {
        return snapshot.decision();
    }

    public Settlement settlement() {
        return snapshot.settlement();
    }

    public RecoveryReason recovery() {
        return snapshot.recovery();
    }

    public CancellationRequest cancellation() {
        return snapshot.cancellation();
    }

    public ProfileAlias profile() {
        return snapshot.profile();
    }

    public AuditState audit() {
        return snapshot.audit();
    }

    /** The history row of the last transition. */
    public OperationEvent event() {
        return new OperationEvent(snapshot.version(), snapshot.state(), snapshot.updatedAt());
    }

    /** True when a request with this contract digest is the same operation as this one. */
    public boolean hasContract(Digest digest) {
        return snapshot.contractDigest().equals(digest);
    }

    /** T2: the automatic approval starts evaluating the operation. */
    public Operation beginEvaluation(Instant at) {
        requireMove(OperationState.EVALUATING);
        return new Operation(snapshot.advanced(OperationState.EVALUATING, at));
    }

    /** T3: evaluation is over, or there was none; the owner decides. */
    public Operation awaitOwnerDecision(Instant at) {
        requireMove(OperationState.PENDING);
        return new Operation(snapshot.advanced(OperationState.PENDING, at));
    }

    /** Records the automatic approval's decision. The state stays; the version moves, as for every change. */
    public Operation recordDecision(DecisionRecord decision, Instant at) {
        Objects.requireNonNull(decision, "decision");
        return switch (state()) {
            case ACCEPTED, EVALUATING, PENDING -> new Operation(snapshot.advanced(state(), at).withDecision(decision));
            case QUEUED, STARTING, RUNNING, TERMINATING, COMPLETED, FAILED, CANCELLED, DENIED, EXPIRED, UNKNOWN -> throw invalidTransition(state(), "record a decision");
        };
    }

    /**
     * T4: approved, and waiting in the execution queue. The deadline must not have passed and the authority must cover the kind of operation; the authority
     * decides the approval mode.
     */
    public Operation enqueue(StartAuthority authority, Instant at) {
        Objects.requireNonNull(authority, "authority");
        requireMove(OperationState.QUEUED);
        if (expiry().isReached(at)) {
            throw invalidTransition(OperationState.QUEUED, "enqueue after its deadline");
        }
        if (!authority.covers(kind())) {
            throw invalidTransition(OperationState.QUEUED, "enqueue under an authority that does not cover " + kind());
        }
        return new Operation(snapshot.advanced(OperationState.QUEUED, at).withApprovalMode(authority.mode()));
    }

    /** T5: the owner or the policy refuses the operation before anything ran. */
    public Operation deny(Instant at) {
        return settledAs(OperationState.DENIED, new RecordedResult.NoResult(), OutcomeCertainty.NOT_DISPATCHED, RecoveryReason.NONE, at);
    }

    /** T6, T10: the deadline has passed before the operation was dispatched. It is not allowed before the deadline, and nothing can undo it. */
    public Operation expire(Instant at) {
        requireMove(OperationState.EXPIRED);
        if (!expiry().isReached(at)) {
            throw invalidTransition(OperationState.EXPIRED, "expire before its deadline");
        }
        return settledAs(OperationState.EXPIRED, new RecordedResult.NoResult(), OutcomeCertainty.NOT_DISPATCHED, RecoveryReason.NONE, at);
    }

    /** T8: a dispatcher claimed the queued operation; the limits were checked by the store in the same transaction. */
    public Operation claim(Instant at) {
        requireMove(OperationState.STARTING);
        return new Operation(snapshot.advanced(OperationState.STARTING, at));
    }

    /** T12: the first step across the external effect boundary. */
    public Operation markRunning(Instant at) {
        requireMove(OperationState.RUNNING);
        return new Operation(snapshot.advanced(OperationState.RUNNING, at));
    }

    /**
     * T7, T13: before dispatch the operation is cancelled at once; while it starts or runs it becomes terminating, and the stop is not confirmed until the
     * executor settles. Asking again while it terminates, or after it ended, changes nothing.
     */
    public Operation requestCancel(Instant at) {
        return switch (state()) {
            case ACCEPTED, EVALUATING, PENDING, QUEUED ->
                settledAs(OperationState.CANCELLED, new RecordedResult.NoResult(), OutcomeCertainty.NOT_DISPATCHED, RecoveryReason.NONE, at);
            case STARTING, RUNNING -> new Operation(snapshot.advanced(OperationState.TERMINATING, at).withCancellation(new CancellationRequest.RequestedAt(at)));
            case TERMINATING, COMPLETED, FAILED, CANCELLED, DENIED, EXPIRED, UNKNOWN -> this;
        };
    }

    /** T9, T24, T25: a guard stopped the operation before dispatch; nothing ran on the target. */
    public Operation refuseBeforeDispatch(DispatchFailure failure, Instant at) {
        Objects.requireNonNull(failure, "failure");
        return switch (state()) {
            case PENDING, QUEUED, STARTING ->
                settledAs(OperationState.FAILED, new RecordedResult.Refused(failure), OutcomeCertainty.NOT_DISPATCHED, RecoveryReason.NONE, at);
            case ACCEPTED, EVALUATING, RUNNING, TERMINATING, COMPLETED, FAILED, CANCELLED, DENIED, EXPIRED, UNKNOWN ->
                throw invalidTransition(OperationState.FAILED, "be refused before dispatch");
        };
    }

    /**
     * T14 to T17: the executor reports how it ended. {@link ExecutionOutcome#verdict()} chooses the state; a completed state needs confirming evidence, an
     * incomplete cleanup or an unknown remote state makes the result unknown.
     */
    public Operation settle(ExecutionOutcome outcome, Instant at) {
        Objects.requireNonNull(outcome, "outcome");
        if (!state().isActive()) {
            throw invalidTransition(outcome.verdict(), "settle an operation that is not running");
        }
        OperationState verdict = outcome.verdict();
        OutcomeCertainty certainty;
        if (verdict == OperationState.UNKNOWN) {
            certainty = OutcomeCertainty.UNKNOWN;
        } else if (outcome.remoteState() == RemoteState.NOT_DISPATCHED) {
            certainty = OutcomeCertainty.NOT_DISPATCHED;
        } else {
            certainty = OutcomeCertainty.EXITED;
        }
        return settledAs(verdict, new RecordedResult.Executed(outcome), certainty, RecoveryReason.NONE, at);
    }

    /**
     * T18, T20, T21: the bridge started again and found the operation in flight. What was running (or being evaluated) is unknown, what waited for the owner
     * expires, and what already ended stays as it is. Nothing is replayed. A queued operation is left as it is (main's ruling, T19 withdrawn): the journal is
     * durable and the claim from queued to starting happens before any external effect in one transaction, so a queued operation was certainly never tried; the
     * scheduler dispatches or expires it as usual (case B-200).
     */
    public Operation recoverAfterRestart(Instant at) {
        return switch (state()) {
            case PENDING -> settledAs(OperationState.EXPIRED, new RecordedResult.NoResult(), OutcomeCertainty.NOT_DISPATCHED, RecoveryReason.BRIDGE_RESTART, at);
            case ACCEPTED, EVALUATING, STARTING, RUNNING, TERMINATING ->
                settledAs(OperationState.UNKNOWN, new RecordedResult.NoResult(), OutcomeCertainty.UNKNOWN, RecoveryReason.BRIDGE_RESTART, at);
            case QUEUED, COMPLETED, FAILED, CANCELLED, DENIED, EXPIRED, UNKNOWN -> this;
        };
    }

    /** T23: evaluating the approval or storing the operation was interrupted; what happened is not known. */
    public Operation abortEvaluation(Instant at) {
        return switch (state()) {
            case ACCEPTED, EVALUATING, QUEUED ->
                settledAs(OperationState.UNKNOWN, new RecordedResult.NoResult(), OutcomeCertainty.UNKNOWN, RecoveryReason.NONE, at);
            case PENDING, STARTING, RUNNING, TERMINATING, COMPLETED, FAILED, CANCELLED, DENIED, EXPIRED, UNKNOWN ->
                throw invalidTransition(OperationState.UNKNOWN, "abort an evaluation");
        };
    }

    /**
     * T22: the owner compared the target with the record. The only way out of {@code UNKNOWN}. The recorded result stays; the certainty becomes what the evidence
     * established, and the operation no longer needs reconciling.
     */
    public Operation reconcile(ReconciliationEvidence evidence, Instant at) {
        Objects.requireNonNull(evidence, "evidence");
        if (!(snapshot.settlement() instanceof Settlement.Settled previous) || state() != OperationState.UNKNOWN) {
            throw invalidTransition(OperationState.COMPLETED, "reconcile an operation that is not unknown");
        }
        OperationState to = switch (evidence) {
            case ReconciliationEvidence.Completed completed -> OperationState.COMPLETED;
            case ReconciliationEvidence.Failed failed -> OperationState.FAILED;
            case ReconciliationEvidence.NeverRan neverRan -> OperationState.CANCELLED;
        };
        OutcomeCertainty certainty = to == OperationState.CANCELLED ? OutcomeCertainty.NOT_DISPATCHED : OutcomeCertainty.EXITED;
        requireMove(to);
        Settlement reconciled = new Settlement.Settled(previous.result(), certainty, Reconciliation.NOT_REQUIRED, previous.finishedAt());
        return new Operation(snapshot.advanced(to, at).withSettlement(reconciled));
    }

    /** The final audit record could not be written. The state stays; the flag tells every later reader that the operation must not be retried automatically. */
    public Operation recordAuditFailure(Instant at) {
        return new Operation(snapshot.advanced(state(), at).withAudit(AuditState.FAILED));
    }

    private Operation settledAs(OperationState to, RecordedResult result, OutcomeCertainty certainty, RecoveryReason recovery, Instant at) {
        requireMove(to);
        Reconciliation reconciliation = certainty == OutcomeCertainty.UNKNOWN ? Reconciliation.REQUIRED : Reconciliation.NOT_REQUIRED;
        return new Operation(snapshot.advanced(to, at).withSettlement(new Settlement.Settled(result, certainty, reconciliation, at)).withRecovery(recovery));
    }

    private void requireMove(OperationState to) {
        if (!state().canMoveTo(to)) {
            throw invalidTransition(to, "move");
        }
    }

    private RequestRefusedException invalidTransition(OperationState to, String attempted) {
        return new RequestRefusedException(OperationErrorCode.INVALID_OPERATION_TRANSITION,
            new IllegalStateException("Operation " + id().value() + " cannot " + attempted + " from " + state() + " to " + to));
    }
}
