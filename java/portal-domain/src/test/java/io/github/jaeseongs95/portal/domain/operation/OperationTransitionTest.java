package io.github.jaeseongs95.portal.domain.operation;

import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.REVISION;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.T0;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.accepted;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.assertInvalidTransition;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.command;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.evaluating;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.id;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.pending;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.queued;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.running;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.starting;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.terminating;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.domain.approval.MaintenancePolicy;
import io.github.jaeseongs95.portal.domain.contract.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.failure.DispatchFailure;
import io.github.jaeseongs95.portal.domain.failure.DispatchReason;
import io.github.jaeseongs95.portal.domain.failure.DispatchStage;
import io.github.jaeseongs95.portal.domain.failure.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class OperationTransitionTest {

    private static final Instant HOUR_AFTER_T0 = T0.plus(Duration.ofHours(1));

    @Test
    @DisplayName("RC-A-765 the intent is stored as accepted, goes to the owner as pending, is queued by the owner's start, then claimed, run and completed with its evidence")
    void lifeOfAnOwnerApprovedCommand() {
        Operation accepted = accepted();
        assertThat(accepted.state()).isEqualTo(OperationState.ACCEPTED);
        assertThat(accepted.version()).isEqualTo(1);
        assertThat(accepted.input()).isEqualTo(new CommandInput(new CommandText("printf ok"), new Utf8Text(""), new Utf8Text("")));
        Operation pending = pending();
        assertThat(pending.state()).isEqualTo(OperationState.PENDING);
        assertThat(pending.approvalMode()).as("nothing runs before the approval").isEqualTo(ApprovalMode.NOT_DECIDED);
        Operation queued = queued();
        assertThat(queued.state()).isEqualTo(OperationState.QUEUED);
        assertThat(queued.approvalMode()).isEqualTo(ApprovalMode.OWNER);
        Operation running = running();
        assertThat(running.state()).isEqualTo(OperationState.RUNNING);
        Operation completed = running.settle(ExecutionOutcome.exited(0, List.of("done")), T0.plusSeconds(5));
        assertThat(completed.state()).isEqualTo(OperationState.COMPLETED);
        assertThat(completed.version()).isEqualTo(6);
        assertThat(completed.approvalMode()).isEqualTo(ApprovalMode.OWNER);
        assertThat(completed.settlement()).isInstanceOfSatisfying(Settlement.Settled.class, settled -> {
            assertThat(settled.certainty()).isEqualTo(OutcomeCertainty.EXITED);
            assertThat(settled.reconciliation()).isEqualTo(Reconciliation.NOT_REQUIRED);
            assertThat(settled.finishedAt()).isEqualTo(T0.plusSeconds(5));
            assertThat(settled.result()).isInstanceOf(RecordedResult.Executed.class);
        });
    }

    @Test
    @DisplayName("RC-A-083 the default deadline is one hour after the request; a requested deadline at or before the request, or later than one hour, is refused")
    void deadlineOfTheApproval() {
        assertThat(accepted().expiry()).isEqualTo(new Deadline.At(HOUR_AFTER_T0));
        assertThat(Operation.accept(command("fixture-key-000002", "ls", "alpha", new ConflictKey.None(), new Deadline.At(HOUR_AFTER_T0)), id('2'), T0).expiry())
            .as("exactly one hour is allowed").isEqualTo(new Deadline.At(HOUR_AFTER_T0));
        for (Instant refused : List.of(T0, T0.minusMillis(1), HOUR_AFTER_T0.plusMillis(1))) {
            assertThatThrownBy(() -> Operation.accept(command("fixture-key-000003", "ls", "alpha", new ConflictKey.None(), new Deadline.At(refused)), id('3'), T0))
                .as("deadline %s", refused).isInstanceOf(IllegalArgumentException.class).hasMessage("Invalid approval deadline");
        }
        assertThatThrownBy(() -> new Deadline.At(null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("RC-A-157 S2-ST-06 an operation expires exactly at its deadline, not a nanosecond before; a restored operation keeps its original deadline")
    void expiryBoundary() {
        Operation pending = pending();
        assertInvalidTransition(() -> pending.expire(HOUR_AFTER_T0.minusNanos(1)));
        Operation expired = pending.expire(HOUR_AFTER_T0);
        assertThat(expired.state()).isEqualTo(OperationState.EXPIRED);
        assertThat(pending.expire(HOUR_AFTER_T0.plusNanos(1)).state()).isEqualTo(OperationState.EXPIRED);
        Operation shortLived = Operation.accept(command("fixture-key-000004", "ls", "alpha", new ConflictKey.None(), new Deadline.At(T0.plusSeconds(600))), id('4'), T0)
            .awaitOwnerDecision(T0.plusSeconds(1));
        Operation restored = Operation.restore(shortLived.snapshot());
        assertThat(restored.expiry()).isEqualTo(new Deadline.At(T0.plusSeconds(600)));
        assertThat(restored.expire(T0.plusSeconds(600)).state()).isEqualTo(OperationState.EXPIRED);
        assertInvalidTransition(() -> pending.expire(T0.plusSeconds(600)));
        assertThat(expired.settlement()).isInstanceOfSatisfying(Settlement.Settled.class, settled -> assertThat(settled.certainty()).isEqualTo(OutcomeCertainty.NOT_DISPATCHED));
    }

    @Test
    @DisplayName("RC-A-157 a final operation never moves again, and an expired one cannot be started")
    void finalStatesAreFinal() {
        Operation expired = pending().expire(HOUR_AFTER_T0);
        assertInvalidTransition(() -> expired.enqueue(new StartAuthority.Owner(), HOUR_AFTER_T0));
        assertInvalidTransition(() -> expired.deny(HOUR_AFTER_T0));
        assertInvalidTransition(() -> expired.claim(HOUR_AFTER_T0));
        assertThat(expired.requestCancel(HOUR_AFTER_T0)).as("asking for a cancel of an ended operation changes nothing").isSameAs(expired);
        assertInvalidTransition(() -> pending().enqueue(new StartAuthority.Owner(), HOUR_AFTER_T0));
    }

    @Test
    @DisplayName("S2-ST-01 every transition method refuses a state the table does not allow, with INVALID_OPERATION_TRANSITION")
    void methodsRefuseWrongStates() {
        DispatchFailure refusal = DispatchFailure.refused(DispatchReason.AUTHORITY, DispatchStage.AUTHORITY);
        assertInvalidTransition(() -> accepted().enqueue(new StartAuthority.Owner(), T0));
        assertInvalidTransition(() -> evaluating().enqueue(new StartAuthority.Owner(), T0));
        assertInvalidTransition(() -> pending().claim(T0));
        assertInvalidTransition(() -> queued().markRunning(T0));
        assertInvalidTransition(() -> running().claim(T0));
        assertInvalidTransition(() -> running().deny(T0));
        assertInvalidTransition(() -> running().expire(HOUR_AFTER_T0));
        assertInvalidTransition(() -> running().awaitOwnerDecision(T0));
        assertInvalidTransition(() -> queued().beginEvaluation(T0));
        assertInvalidTransition(() -> starting().refuseBeforeDispatch(refusal, T0).claim(T0));
        assertInvalidTransition(() -> running().refuseBeforeDispatch(refusal, T0));
        assertInvalidTransition(() -> pending().settle(ExecutionOutcome.exited(0, List.of()), T0));
        assertInvalidTransition(() -> queued().recordDecision(new DecisionRecord.NoDecision(), T0));
        assertInvalidTransition(() -> pending().abortEvaluation(T0));
        assertInvalidTransition(() -> running().reconcile(new ReconciliationEvidence.Failed(), T0));
    }

    @Test
    @DisplayName("S2-ST-01 a policy authority starts only the kind of operation it covers, and the owner starts every kind")
    void authorityCoversTheKind() {
        assertInvalidTransition(() -> pending().enqueue(new StartAuthority.Policy(StartAuthority.PolicyScope.UPLOAD), T0.plusSeconds(2)));
        assertInvalidTransition(() -> pending().enqueue(new StartAuthority.Policy(StartAuthority.PolicyScope.DOWNLOAD), T0.plusSeconds(2)));
        Operation automatic = pending().enqueue(new StartAuthority.Policy(StartAuthority.PolicyScope.COMMAND), T0.plusSeconds(2));
        assertThat(automatic.approvalMode()).isEqualTo(ApprovalMode.AUTOMATIC);
        assertThat(pending().enqueue(new StartAuthority.Policy(StartAuthority.PolicyScope.READ), T0.plusSeconds(2)).approvalMode()).isEqualTo(ApprovalMode.AUTOMATIC);
    }

    @Test
    @DisplayName("S2-ST-02 settle follows the decision table: incomplete cleanup, unknown remote state and required reconciliation give unknown")
    void settleRowsOneAndTwo() {
        Operation incomplete = running().settle(outcome(ExecutionReason.EXIT, RemoteState.EXITED, new ExitStatus.Exited(0), CleanupState.INCOMPLETE, Reconciliation.NOT_REQUIRED,
            ResultFlag.OK, new CompletionEvidence.CommandExited(0)), T0.plusSeconds(5));
        assertUnknown(incomplete);
        Operation remoteUnknown = running().settle(outcome(ExecutionReason.TRANSPORT_LOST, RemoteState.UNKNOWN, new ExitStatus.NoExit(), CleanupState.COMPLETE,
            Reconciliation.NOT_REQUIRED, ResultFlag.FAILED, new CompletionEvidence.NoEvidence()), T0.plusSeconds(5));
        assertUnknown(remoteUnknown);
        Operation reconcile = running().settle(outcome(ExecutionReason.EXIT, RemoteState.EXITED, new ExitStatus.Exited(0), CleanupState.COMPLETE, Reconciliation.REQUIRED,
            ResultFlag.OK, new CompletionEvidence.CommandExited(0)), T0.plusSeconds(5));
        assertUnknown(reconcile);
    }

    @Test
    @DisplayName("S2-ST-02 settle follows the decision table: a cancel is cancelled, a failure of any kind is failed, a clean exit with evidence is completed")
    void settleRowsThreeToFive() {
        Operation cancelled = terminating().settle(outcome(ExecutionReason.CANCEL, RemoteState.NOT_DISPATCHED, new ExitStatus.NoExit(), CleanupState.COMPLETE,
            Reconciliation.NOT_REQUIRED, ResultFlag.FAILED, new CompletionEvidence.NoEvidence()), T0.plusSeconds(6));
        assertThat(cancelled.state()).isEqualTo(OperationState.CANCELLED);
        assertCertainty(cancelled, OutcomeCertainty.NOT_DISPATCHED);
        List<ExecutionOutcome> failures = List.of(
            outcome(ExecutionReason.EXIT, RemoteState.EXITED, new ExitStatus.Exited(0), CleanupState.COMPLETE, Reconciliation.NOT_REQUIRED, ResultFlag.FAILED,
                new CompletionEvidence.CommandExited(0)),
            outcome(ExecutionReason.INPUT_FAILED, RemoteState.NOT_DISPATCHED, new ExitStatus.NoExit(), CleanupState.COMPLETE, Reconciliation.NOT_REQUIRED, ResultFlag.FAILED,
                new CompletionEvidence.NoEvidence()),
            outcome(ExecutionReason.DEADLINE, RemoteState.EXITED, new ExitStatus.NoExit(), CleanupState.COMPLETE, Reconciliation.NOT_REQUIRED, ResultFlag.OK,
                new CompletionEvidence.NoEvidence()),
            outcome(ExecutionReason.EXIT, RemoteState.EXITED, new ExitStatus.Exited(1), CleanupState.COMPLETE, Reconciliation.NOT_REQUIRED, ResultFlag.OK,
                new CompletionEvidence.CommandExited(1)),
            outcome(ExecutionReason.EXIT, RemoteState.EXITED, new ExitStatus.Signaled("KILL"), CleanupState.COMPLETE, Reconciliation.NOT_REQUIRED, ResultFlag.OK,
                new CompletionEvidence.NoEvidence()));
        for (ExecutionOutcome failure : failures) {
            Operation failed = running().settle(failure, T0.plusSeconds(5));
            assertThat(failed.state()).as("outcome %s", failure).isEqualTo(OperationState.FAILED);
            assertThat(failed.settlement()).isInstanceOfSatisfying(Settlement.Settled.class, settled -> assertThat(settled.reconciliation()).isEqualTo(Reconciliation.NOT_REQUIRED));
        }
        Operation completed = running().settle(ExecutionOutcome.exited(0, List.of()), T0.plusSeconds(5));
        assertThat(completed.state()).isEqualTo(OperationState.COMPLETED);
        assertCertainty(completed, OutcomeCertainty.EXITED);
        assertThat(starting().settle(ExecutionOutcome.exited(0, List.of()), T0.plusSeconds(5)).state()).as("an executor may settle right after the claim")
            .isEqualTo(OperationState.COMPLETED);
    }

    @Test
    @DisplayName("S2-ST-03 RC-A-770 completion needs confirming evidence: none is unknown, an exit code other than 0 is failed, file evidence completes a transfer")
    void completionNeedsEvidence() {
        Operation noEvidence = running().settle(outcome(ExecutionReason.EXIT, RemoteState.EXITED, new ExitStatus.Exited(0), CleanupState.COMPLETE, Reconciliation.NOT_REQUIRED,
            ResultFlag.OK, new CompletionEvidence.NoEvidence()), T0.plusSeconds(5));
        assertUnknown(noEvidence);
        Digest digest = new Digest("c".repeat(64));
        ExecutionOutcome published = outcome(ExecutionReason.EXIT, RemoteState.EXITED, new ExitStatus.NoExit(), CleanupState.COMPLETE, Reconciliation.NOT_REQUIRED, ResultFlag.OK,
            new CompletionEvidence.FilePublished(T0.plusSeconds(4), digest));
        assertThat(running().settle(published, T0.plusSeconds(5)).state()).isEqualTo(OperationState.COMPLETED);
        ExecutionOutcome unverifiedRead = outcome(ExecutionReason.EXIT, RemoteState.EXITED, new ExitStatus.NoExit(), CleanupState.COMPLETE, Reconciliation.NOT_REQUIRED,
            ResultFlag.OK, new CompletionEvidence.FileRead(false));
        assertUnknown(running().settle(unverifiedRead, T0.plusSeconds(5)));
        ExecutionOutcome verifiedRead = outcome(ExecutionReason.EXIT, RemoteState.EXITED, new ExitStatus.NoExit(), CleanupState.COMPLETE, Reconciliation.NOT_REQUIRED,
            ResultFlag.OK, new CompletionEvidence.FileRead(true));
        assertThat(running().settle(verifiedRead, T0.plusSeconds(5)).state()).isEqualTo(OperationState.COMPLETED);
        assertThat(running().settle(ExecutionOutcome.exited(2, List.of()), T0.plusSeconds(5)).state()).isEqualTo(OperationState.FAILED);
        assertThat(new CompletionEvidence.CommandExited(0).confirmsCompletion()).isTrue();
        assertThat(new CompletionEvidence.CommandExited(1).confirmsCompletion()).isFalse();
        assertThat(new CompletionEvidence.NoEvidence().confirmsCompletion()).isFalse();
        assertThatThrownBy(() -> outcome(ExecutionReason.EXIT, RemoteState.EXITED, new ExitStatus.Exited(0), CleanupState.COMPLETE, Reconciliation.NOT_REQUIRED, ResultFlag.OK,
            new CompletionEvidence.CommandExited(3))).as("evidence and exit status name different codes").isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("RC-A-770 RC-B-359 an uncertain execution is unknown and reconciliation is required; nothing starts it again and the same key finds the same operation")
    void uncertainExecutionIsNeverReplayed() {
        ExecutionOutcome lost = ExecutionOutcome.transportLost(new ExecutionFailure.Unclassified(), List.of("Operation failed; do not replay automatically."));
        Operation unknown = running().settle(lost, T0.plusSeconds(5));
        assertUnknown(unknown);
        assertInvalidTransition(() -> unknown.enqueue(new StartAuthority.Owner(), T0.plusSeconds(6)));
        assertInvalidTransition(() -> unknown.claim(T0.plusSeconds(6)));
        assertInvalidTransition(() -> unknown.markRunning(T0.plusSeconds(6)));
        assertInvalidTransition(() -> unknown.expire(HOUR_AFTER_T0));
        assertInvalidTransition(() -> unknown.deny(T0.plusSeconds(6)));
        assertThat(unknown.recoverAfterRestart(T0.plusSeconds(7))).as("a restart does not touch an unknown operation").isSameAs(unknown);
        assertThat(unknown.requestCancel(T0.plusSeconds(7))).isSameAs(unknown);
        assertThat(Operation.restore(unknown.snapshot()).state()).isEqualTo(OperationState.UNKNOWN);
        assertThat(unknown.hasContract(accepted().contractDigest())).as("the same request is the same operation").isTrue();
    }

    @Test
    @DisplayName("S2-ST-04 RC-B-200 a restart makes in-flight operations unknown, an owner step expires, a queued one stays queued (and the scheduler expires it past its deadline)")
    void recoverAfterRestart() {
        Instant restart = T0.plusSeconds(100);
        for (Operation inFlight : List.of(accepted(), evaluating(), starting(), running(), terminating())) {
            Operation recovered = inFlight.recoverAfterRestart(restart);
            assertThat(recovered.state()).as("from %s", inFlight.state()).isEqualTo(OperationState.UNKNOWN);
            assertThat(recovered.recovery()).isEqualTo(RecoveryReason.BRIDGE_RESTART);
            assertThat(recovered.settlement()).isInstanceOfSatisfying(Settlement.Settled.class, settled -> {
                assertThat(settled.certainty()).isEqualTo(OutcomeCertainty.UNKNOWN);
                assertThat(settled.reconciliation()).isEqualTo(Reconciliation.REQUIRED);
            });
            assertThat(recovered.version()).isEqualTo(inFlight.version() + 1);
            assertThat(recovered.event()).isEqualTo(new OperationEvent(inFlight.version() + 1, OperationState.UNKNOWN, restart));
        }
        Operation waiting = pending().recoverAfterRestart(restart);
        assertThat(waiting.state()).isEqualTo(OperationState.EXPIRED);
        assertThat(waiting.recovery()).isEqualTo(RecoveryReason.BRIDGE_RESTART);
        Operation waitingInQueue = queued();
        assertThat(waitingInQueue.recoverAfterRestart(restart)).as("a queued operation was never tried and is left as it is").isSameAs(waitingInQueue);
        Operation late = waitingInQueue.recoverAfterRestart(HOUR_AFTER_T0.plusSeconds(1));
        assertThat(late).isSameAs(waitingInQueue);
        assertThat(late.expire(HOUR_AFTER_T0.plusSeconds(1)).state()).as("RC-B-200 the scheduler expires it by its original deadline").isEqualTo(OperationState.EXPIRED);
        for (Operation done : List.of(pending().deny(restart), running().settle(ExecutionOutcome.exited(0, List.of()), restart))) {
            assertThat(done.recoverAfterRestart(restart)).as("an ended operation is left as it is").isSameAs(done);
        }
    }

    @Test
    @DisplayName("RC-B-195 an owner's denial before dispatch ends the operation without any start")
    void denialBeforeDispatch() {
        for (Operation waiting : List.of(evaluating(), pending(), queued())) {
            Operation denied = waiting.deny(T0.plusSeconds(10));
            assertThat(denied.state()).isEqualTo(OperationState.DENIED);
            assertThat(denied.settlement()).isInstanceOfSatisfying(Settlement.Settled.class, settled -> {
                assertThat(settled.certainty()).isEqualTo(OutcomeCertainty.NOT_DISPATCHED);
                assertThat(settled.result()).isEqualTo(new RecordedResult.NoResult());
            });
        }
        assertInvalidTransition(() -> accepted().deny(T0));
    }

    @Test
    @DisplayName("RC-B-197 an operation that expires while its dispatch guard runs is expired and never runs")
    void expiryDuringTheDispatchGuard() {
        Operation expired = starting().expire(HOUR_AFTER_T0);
        assertThat(expired.state()).isEqualTo(OperationState.EXPIRED);
        assertInvalidTransition(() -> expired.markRunning(HOUR_AFTER_T0));
    }

    @Test
    @DisplayName("RC-B-199 RC-A-768 RC-A-625 a guard that refuses before dispatch ends the operation as failed without an effect, once")
    void guardRefusal() {
        DispatchFailure policyChanged = DispatchFailure.refused(DispatchReason.POLICY_CHANGED, DispatchStage.POLICY_GUARD);
        Operation refused = starting().refuseBeforeDispatch(policyChanged, T0.plusSeconds(4));
        assertThat(refused.state()).isEqualTo(OperationState.FAILED);
        assertThat(refused.settlement()).isInstanceOfSatisfying(Settlement.Settled.class, settled -> {
            assertThat(settled.result()).isEqualTo(new RecordedResult.Refused(policyChanged));
            assertThat(settled.certainty()).isEqualTo(OutcomeCertainty.NOT_DISPATCHED);
            assertThat(settled.reconciliation()).isEqualTo(Reconciliation.NOT_REQUIRED);
        });
        assertInvalidTransition(() -> refused.refuseBeforeDispatch(policyChanged, T0.plusSeconds(5)));
        assertThat(pending().refuseBeforeDispatch(DispatchFailure.refused(DispatchReason.QUEUE_FULL, DispatchStage.EXECUTION_QUEUE), T0.plusSeconds(3)).state())
            .isEqualTo(OperationState.FAILED);
        assertThat(queued().refuseBeforeDispatch(new MaintenancePolicy().failureForQueuedOperation(), T0.plusSeconds(3)).state()).isEqualTo(OperationState.FAILED);
    }

    @Test
    @DisplayName("RC-A-626 a failure before dispatch and a failure after it are told apart: not dispatched and certain, against unknown and to be reconciled")
    void certaintyAfterAFailure() {
        Operation before = starting().refuseBeforeDispatch(DispatchFailure.stepFailed(DispatchStage.START_PERSISTENCE, DispatchReason.PERSISTENCE_FAILED), T0.plusSeconds(4));
        Operation after = running().settle(ExecutionOutcome.transportLost(new ExecutionFailure.Unclassified(), List.of()), T0.plusSeconds(5));
        assertThat(before.state()).isEqualTo(OperationState.FAILED);
        assertCertainty(before, OutcomeCertainty.NOT_DISPATCHED);
        assertThat(after.state()).isEqualTo(OperationState.UNKNOWN);
        assertCertainty(after, OutcomeCertainty.UNKNOWN);
    }

    @Test
    @DisplayName("S2-ST-01 a cancel before dispatch cancels at once; while starting or running it is terminating until the executor settles")
    void cancellation() {
        for (Operation waiting : List.of(accepted(), evaluating(), pending(), queued())) {
            assertThat(waiting.requestCancel(T0.plusSeconds(9)).state()).isEqualTo(OperationState.CANCELLED);
        }
        for (Operation active : List.of(starting(), running())) {
            Operation terminating = active.requestCancel(T0.plusSeconds(9));
            assertThat(terminating.state()).isEqualTo(OperationState.TERMINATING);
            assertThat(terminating.cancellation()).isEqualTo(new CancellationRequest.RequestedAt(T0.plusSeconds(9)));
            assertThat(terminating.requestCancel(T0.plusSeconds(10))).as("a second cancel changes nothing").isSameAs(terminating);
        }
    }

    @Test
    @DisplayName("S2-ST-01 only the owner's reconciliation moves an unknown operation, to what the evidence says")
    void reconciliation() {
        Operation unknown = running().settle(ExecutionOutcome.transportLost(new ExecutionFailure.Unclassified(), List.of()), T0.plusSeconds(5));
        Operation completed = unknown.reconcile(new ReconciliationEvidence.Completed(new CompletionEvidence.CommandExited(0)), T0.plusSeconds(60));
        assertThat(completed.state()).isEqualTo(OperationState.COMPLETED);
        assertThat(completed.settlement()).isInstanceOfSatisfying(Settlement.Settled.class, settled -> {
            assertThat(settled.reconciliation()).isEqualTo(Reconciliation.NOT_REQUIRED);
            assertThat(settled.certainty()).isEqualTo(OutcomeCertainty.EXITED);
            assertThat(settled.finishedAt()).as("the end of the operation stays what it was").isEqualTo(T0.plusSeconds(5));
        });
        assertThat(unknown.reconcile(new ReconciliationEvidence.Failed(), T0.plusSeconds(60)).state()).isEqualTo(OperationState.FAILED);
        Operation cancelled = unknown.reconcile(new ReconciliationEvidence.NeverRan(), T0.plusSeconds(60));
        assertThat(cancelled.state()).isEqualTo(OperationState.CANCELLED);
        assertCertainty(cancelled, OutcomeCertainty.NOT_DISPATCHED);
        assertThatThrownBy(() -> new ReconciliationEvidence.Completed(new CompletionEvidence.NoEvidence())).isInstanceOf(IllegalArgumentException.class);
        assertInvalidTransition(() -> completed.reconcile(new ReconciliationEvidence.Failed(), T0.plusSeconds(61)));
    }

    @Test
    @DisplayName("S2-ST-05 the contract does not change in any transition, every transition adds one to the version, and the contract digest stays")
    void contractIsImmutable() {
        Operation first = accepted();
        List<Operation> chain = new ArrayList<>();
        chain.add(first);
        chain.add(chain.get(0).awaitOwnerDecision(T0.plusSeconds(1)));
        chain.add(chain.get(1).enqueue(new StartAuthority.Owner(), T0.plusSeconds(2)));
        chain.add(chain.get(2).claim(T0.plusSeconds(3)));
        chain.add(chain.get(3).markRunning(T0.plusSeconds(4)));
        chain.add(chain.get(4).settle(ExecutionOutcome.exited(0, List.of()), T0.plusSeconds(5)));
        for (int i = 0; i < chain.size(); i++) {
            Operation step = chain.get(i);
            assertThat(step.version()).isEqualTo(i + 1);
            assertThat(step.event().version()).isEqualTo(i + 1);
            assertThat(step.requestKey()).isEqualTo(first.requestKey());
            assertThat(step.owner()).isEqualTo(first.owner());
            assertThat(step.targetId()).isEqualTo(first.targetId());
            assertThat(step.targetRevision()).isEqualTo(REVISION);
            assertThat(step.kind()).isEqualTo(first.kind());
            assertThat(step.input()).isEqualTo(first.input());
            assertThat(step.createdAt()).isEqualTo(first.createdAt());
            assertThat(step.expiry()).isEqualTo(first.expiry());
            assertThat(step.conflictKey()).isEqualTo(first.conflictKey());
            assertThat(step.contractDigest()).isEqualTo(first.contractDigest());
        }
        assertThat(chain.get(0).state()).isEqualTo(OperationState.ACCEPTED);
        assertThat(chain.get(5).state()).isEqualTo(OperationState.COMPLETED);
    }

    @Test
    @DisplayName("RC-A-771 the identity of a submission is kept in the operation: id, key, owner and the contract digest")
    void submissionIdentity() {
        NewOperation spec = command("owner-request-key", "printf ok");
        Operation operation = Operation.accept(spec, id('9'), T0);
        assertThat(operation.id()).isEqualTo(id('9'));
        assertThat(operation.requestKey()).isEqualTo(new RequestKey("owner-request-key"));
        assertThat(operation.owner().value()).isEqualTo("fixture-owner");
        assertThat(operation.contractDigest()).isEqualTo(spec.contractDigest());
        assertThat(operation.hasContract(spec.contractDigest())).isTrue();
        assertThat(operation.createdAt()).isEqualTo(T0);
        assertThat(Operation.restore(operation.snapshot()).snapshot()).isEqualTo(operation.snapshot());
    }

    @Test
    @DisplayName("RC-B-073 RC-B-187 the same request has the same contract digest, and a changed input, owner, target, conflict key or deadline has another")
    void contractDigest() {
        String text = "printf first\nprintf second\n";
        Digest base = command("same-request-key-001", text).contractDigest();
        assertThat(command("same-request-key-001", text).contractDigest()).isEqualTo(base);
        assertThat(command("same-request-key-001", "printf first\r\nprintf second\r\n").contractDigest()).isNotEqualTo(base);
        assertThat(command("same-request-key-001", " printf first\nprintf second\n").contractDigest()).isNotEqualTo(base);
        assertThat(command("same-request-key-001", "printf first\nprintf second").contractDigest()).isNotEqualTo(base);
        assertThat(command("same-request-key-001", text, "beta", new ConflictKey.None(), new Deadline.None()).contractDigest()).isNotEqualTo(base);
        assertThat(command("same-request-key-001", text, "alpha", new ConflictKey.Of("install"), new Deadline.None()).contractDigest()).isNotEqualTo(base);
        assertThat(command("same-request-key-001", text, "alpha", new ConflictKey.None(), new Deadline.At(T0.plusSeconds(10))).contractDigest()).isNotEqualTo(base);
    }

    @Test
    @DisplayName("S2-ST-05 a stored operation that breaks an invariant is refused when it is restored")
    void restoreChecksInvariants() {
        OperationSnapshot good = running().snapshot();
        OperationSnapshot wrongVersion = new OperationSnapshot(good.id(), good.requestKey(), good.owner(), good.targetId(), good.targetRevision(), good.kind(), good.input(),
            good.contractDigest(), good.createdAt(), good.expiry(), good.conflictKey(), good.state(), 0, good.updatedAt(), good.approvalMode(), good.decision(), good.settlement(),
            good.recovery(), good.cancellation(), good.profile(), good.audit());
        OperationSnapshot settledWhileRunning = new OperationSnapshot(good.id(), good.requestKey(), good.owner(), good.targetId(), good.targetRevision(), good.kind(), good.input(),
            good.contractDigest(), good.createdAt(), good.expiry(), good.conflictKey(), good.state(), good.version(), good.updatedAt(), good.approvalMode(), good.decision(),
            new Settlement.Settled(new RecordedResult.NoResult(), OutcomeCertainty.NOT_DISPATCHED, Reconciliation.NOT_REQUIRED, T0), good.recovery(), good.cancellation(),
            good.profile(), good.audit());
        OperationSnapshot undecidedWhileRunning = new OperationSnapshot(good.id(), good.requestKey(), good.owner(), good.targetId(), good.targetRevision(), good.kind(),
            good.input(), good.contractDigest(), good.createdAt(), good.expiry(), good.conflictKey(), good.state(), good.version(), good.updatedAt(), ApprovalMode.NOT_DECIDED,
            good.decision(), good.settlement(), good.recovery(), good.cancellation(), good.profile(), good.audit());
        OperationSnapshot terminatingWithoutRequest = new OperationSnapshot(good.id(), good.requestKey(), good.owner(), good.targetId(), good.targetRevision(), good.kind(),
            good.input(), good.contractDigest(), good.createdAt(), good.expiry(), good.conflictKey(), OperationState.TERMINATING, good.version(), good.updatedAt(),
            good.approvalMode(), good.decision(), good.settlement(), good.recovery(), good.cancellation(), good.profile(), good.audit());
        for (OperationSnapshot broken : List.of(wrongVersion, settledWhileRunning, undecidedWhileRunning, terminatingWithoutRequest)) {
            assertThatThrownBy(() -> Operation.restore(broken)).isInstanceOfSatisfying(RequestRefusedException.class,
                e -> assertThat(e.code()).isEqualTo(OperationErrorCode.INVALID_OPERATION_RECORD));
        }
        assertThat(Operation.restore(good).snapshot()).isEqualTo(good);
    }

    @Test
    @DisplayName("S2-ST-05 a decision is recorded without moving the state; the audit failure is a flag that does not change the state")
    void decisionAndAuditFailure() {
        DecisionRecord decided = new DecisionRecord.Decided(DecisionKind.EXECUTE, DecisionReason.COMMAND_SET, ReviewReason.NONE, 7);
        Operation recorded = evaluating().recordDecision(decided, T0.plusSeconds(2));
        assertThat(recorded.state()).isEqualTo(OperationState.EVALUATING);
        assertThat(recorded.version()).isEqualTo(3);
        assertThat(recorded.decision().isExecute()).isTrue();
        Operation audited = recorded.recordAuditFailure(T0.plusSeconds(3));
        assertThat(audited.audit()).isEqualTo(AuditState.FAILED);
        assertThat(audited.state()).isEqualTo(OperationState.EVALUATING);
        assertThat(new DecisionRecord.NoDecision().isExecute()).isFalse();
        assertThat(Arrays.stream(DecisionReason.values()).filter(DecisionReason::isAutomatic)).containsExactlyInAnyOrder(DecisionReason.COMMAND_SET, DecisionReason.MODEL_PASSED,
            DecisionReason.TEST_SERVER_BYPASS);
    }

    private static ExecutionOutcome outcome(ExecutionReason reason, RemoteState remote, ExitStatus exit, CleanupState cleanup, Reconciliation reconciliation, ResultFlag failed,
                                            CompletionEvidence evidence) {
        return new ExecutionOutcome(reason, remote, exit, SignalDelivery.NOT_SENT, cleanup, reconciliation, OutputState.NOT_REPORTED, CaptureState.NOT_REPORTED,
            new TimeoutMs.None(), new StreamCapture.NotCaptured(), new StreamCapture.NotCaptured(), new ExecutionFailure.Unclassified(), failed, List.of(), evidence);
    }

    private static void assertUnknown(Operation operation) {
        assertThat(operation.state()).isEqualTo(OperationState.UNKNOWN);
        assertCertainty(operation, OutcomeCertainty.UNKNOWN);
        assertThat(operation.settlement()).isInstanceOfSatisfying(Settlement.Settled.class,
            settled -> assertThat(settled.reconciliation()).isEqualTo(Reconciliation.REQUIRED));
    }

    private static void assertCertainty(Operation operation, OutcomeCertainty certainty) {
        assertThat(operation.settlement()).isInstanceOfSatisfying(Settlement.Settled.class, settled -> assertThat(settled.certainty()).isEqualTo(certainty));
    }
}
