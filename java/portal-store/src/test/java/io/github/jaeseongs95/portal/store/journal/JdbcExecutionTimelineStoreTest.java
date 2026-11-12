package io.github.jaeseongs95.portal.store.journal;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.Import;

import io.github.jaeseongs95.portal.app.journal.ClaimResult;
import io.github.jaeseongs95.portal.app.remote.ExecutionPhase;
import io.github.jaeseongs95.portal.app.remote.ExecutionTimeline;
import io.github.jaeseongs95.portal.app.remote.PhaseMark;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.error.ExecutionStage;
import io.github.jaeseongs95.portal.domain.error.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.error.RemoteOutcome;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.operation.CaptureState;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.operation.CompletionEvidence;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import io.github.jaeseongs95.portal.domain.operation.ExitStatus;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.OutputState;
import io.github.jaeseongs95.portal.domain.operation.ReconciliationEvidence;
import io.github.jaeseongs95.portal.domain.operation.Reconciliation;
import io.github.jaeseongs95.portal.domain.operation.RecordedResult;
import io.github.jaeseongs95.portal.domain.operation.RemoteState;
import io.github.jaeseongs95.portal.domain.operation.ResultFlag;
import io.github.jaeseongs95.portal.domain.operation.Settlement;
import io.github.jaeseongs95.portal.domain.operation.SignalDelivery;
import io.github.jaeseongs95.portal.domain.operation.StreamCapture;
import io.github.jaeseongs95.portal.domain.operation.TimeoutMs;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;
import io.github.jaeseongs95.portal.store.Savepoints;

/**
 * The execution timeline of an operation (migration V7, decision D3-04, defect D-0038) and the failure code that V7 lets the result store
 * ({@code ARTIFACT_STORAGE_FULL}, decision D3-03). The table is the real one of the migrated H2 database.
 */
@JournalTest
@Import(JdbcExecutionTimelineStore.class)
class JdbcExecutionTimelineStoreTest {

    private static final Instant T = JournalFixture.NOW;

    private final JdbcOperationJournal journal;
    private final JdbcClaimStore claims;
    private final JdbcExecutionTimelineStore timelines;
    private final Savepoints savepoints;
    private final JournalFixture fx = new JournalFixture();

    JdbcExecutionTimelineStoreTest(JdbcOperationJournal journal, JdbcClaimStore claims, JdbcExecutionTimelineStore timelines, Savepoints savepoints) {
        this.journal = journal;
        this.claims = claims;
        this.timelines = timelines;
        this.savepoints = savepoints;
    }

    @Test
    @DisplayName("D3-04 / D-0038: the instants of connected, request sent and closed are stored with the result and read back in order; the other phases are not stored")
    void theThreeInstantsAreStoredAndReadBack() {
        Operation settled = settledAfterRunning("timeline", ExecutionOutcome.exited(0, List.of("ok")));
        ExecutionTimeline all = ExecutionTimeline.empty().marked(ExecutionPhase.CONNECT_STARTED, T.plusSeconds(10)).marked(ExecutionPhase.CONNECTED, T.plusSeconds(11))
            .marked(ExecutionPhase.CHANNEL_OPENED, T.plusSeconds(12)).marked(ExecutionPhase.REQUEST_SENT, T.plusSeconds(13)).marked(ExecutionPhase.FIRST_OUTPUT, T.plusSeconds(14))
            .marked(ExecutionPhase.EXIT_SEEN, T.plusSeconds(15)).marked(ExecutionPhase.CLOSED, T.plusSeconds(16));

        timelines.record(settled.id(), all);

        ExecutionTimeline stored = timelines.timelineOf(settled.id());
        assertThat(stored.marks()).extracting(PhaseMark::phase).containsExactly(ExecutionPhase.CONNECTED, ExecutionPhase.REQUEST_SENT, ExecutionPhase.CLOSED);
        assertThat(stored.at(ExecutionPhase.CONNECTED)).contains(T.plusSeconds(11));
        assertThat(stored.at(ExecutionPhase.REQUEST_SENT)).contains(T.plusSeconds(13));
        assertThat(stored.at(ExecutionPhase.CLOSED)).contains(T.plusSeconds(16));
        assertThat(journal.find(settled.id()).orElseThrow().snapshot()).as("the outcome itself is untouched").isEqualTo(settled.snapshot());
    }

    @Test
    @DisplayName("D3-04: a step that was not reached has no instant: a connection that failed leaves the later ones empty, a second record replaces the first")
    void anUnreachedStepHasNoInstantAndTheLastRecordWins() {
        Operation settled = settledAfterRunning("partial", ExecutionOutcome.exited(0, List.of("ok")));

        timelines.record(settled.id(), ExecutionTimeline.empty().marked(ExecutionPhase.CONNECT_STARTED, T.plusSeconds(10)));
        assertThat(timelines.timelineOf(settled.id()).marks()).isEmpty();

        timelines.record(settled.id(), ExecutionTimeline.empty().marked(ExecutionPhase.CONNECTED, T.plusSeconds(11)));
        assertThat(timelines.timelineOf(settled.id()).marks()).hasSize(1);

        timelines.record(settled.id(), ExecutionTimeline.empty().marked(ExecutionPhase.CONNECTED, T.plusSeconds(12)).marked(ExecutionPhase.CLOSED, T.plusSeconds(13)));
        assertThat(timelines.timelineOf(settled.id()).at(ExecutionPhase.CONNECTED)).contains(T.plusSeconds(12));
        assertThat(timelines.timelineOf(settled.id()).at(ExecutionPhase.REQUEST_SENT)).isEmpty();
    }

    @Test
    @DisplayName("D3-04: an operation without a result keeps no timeline: asking gives an empty one, recording is refused as INVALID_OPERATION_RECORD, an unknown id reads empty")
    void anOperationWithoutAResultHasNowhereToKeepATimeline() {
        Operation queued = fx.queued(journal, fx.command("noresult", "alpha", "echo none", new ConflictKey.None()));
        ExecutionTimeline one = ExecutionTimeline.empty().marked(ExecutionPhase.CONNECTED, T.plusSeconds(11));

        assertThat(timelines.timelineOf(queued.id()).marks()).isEmpty();
        assertThat(timelines.timelineOf(new OperationId("f".repeat(48))).marks()).isEmpty();
        assertThatThrownBy(() -> savepoints.run(() -> timelines.record(queued.id(), one))).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(OperationErrorCode.INVALID_OPERATION_RECORD));
    }

    @Test
    @DisplayName("D3-04: a result that is stored again, here by the reconciliation of an unknown outcome, keeps the timeline of its execution")
    void aResultStoredAgainKeepsItsTimeline() {
        ExecutionFailure failure = new ExecutionFailure.Classified(ExecutionStage.SSH_EXECUTION, ExecutionErrorCode.SSH_EXECUTION_FAILED, RemoteOutcome.UNKNOWN);
        Operation unknown = settledAfterRunning("again", ExecutionOutcome.transportLost(failure, List.of("lost")));
        timelines.record(unknown.id(), ExecutionTimeline.empty().marked(ExecutionPhase.CONNECTED, T.plusSeconds(11)).marked(ExecutionPhase.REQUEST_SENT, T.plusSeconds(12)));

        Operation reconciled = journal.save(unknown.reconcile(new ReconciliationEvidence.Failed(), T.plusSeconds(60)), unknown.version());

        assertThat(reconciled.state()).isEqualTo(OperationState.FAILED);
        assertThat(timelines.timelineOf(unknown.id()).marks()).hasSize(2);
    }

    @Test
    @DisplayName("D3-03 / V7: the failure code ARTIFACT_STORAGE_FULL of a download that the disk could not take is stored and read back (V1 allowed seven codes only)")
    void theStorageFullFailureCodeIsStored() {
        ExecutionFailure failure = new ExecutionFailure.Classified(ExecutionStage.OPERATION, ExecutionErrorCode.ARTIFACT_STORAGE_FULL, RemoteOutcome.NOT_STARTED);
        ExecutionOutcome notStarted = new ExecutionOutcome(ExecutionReason.INPUT_FAILED, RemoteState.NOT_DISPATCHED, new ExitStatus.NoExit(), SignalDelivery.NOT_SENT,
            CleanupState.COMPLETE, Reconciliation.NOT_REQUIRED, OutputState.NOT_REPORTED, CaptureState.NOT_REPORTED, new TimeoutMs.None(), new StreamCapture.NotCaptured(),
            new StreamCapture.NotCaptured(), failure, ResultFlag.FAILED, List.of("ARTIFACT_STORAGE_FULL"), new CompletionEvidence.NoEvidence());

        Operation failed = settledAfterRunning("full", notStarted);

        assertThat(failed.state()).isEqualTo(OperationState.FAILED);
        Operation read = journal.find(failed.id()).orElseThrow();
        assertThat(read.snapshot()).isEqualTo(failed.snapshot());
        assertThat(read.settlement()).isInstanceOfSatisfying(Settlement.Settled.class,
            settled -> assertThat(settled.result()).isEqualTo(new RecordedResult.Executed(notStarted)));
    }

    private Operation settledAfterRunning(String key, ExecutionOutcome outcome) {
        Operation queued = fx.queued(journal, fx.command(key, "alpha", "echo " + key, new ConflictKey.None()));
        ClaimResult claimed = claims.claim(queued.id(), queued.version(), ConcurrencyLimits.defaults(), T.plusSeconds(2));
        assertThat(claimed).isInstanceOf(ClaimResult.Claimed.class);
        Operation starting = ((ClaimResult.Claimed) claimed).operation();
        Operation running = journal.save(starting.markRunning(T.plusSeconds(3)), starting.version());
        return journal.save(running.settle(outcome, T.plusSeconds(5)), running.version());
    }
}
