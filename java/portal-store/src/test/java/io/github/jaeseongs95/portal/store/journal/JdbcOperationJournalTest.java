package io.github.jaeseongs95.portal.store.journal;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.TimeZone;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.PlatformTransactionManager;

import io.github.jaeseongs95.portal.app.journal.ClaimResult;
import io.github.jaeseongs95.portal.app.journal.JournalInsert;
import io.github.jaeseongs95.portal.domain.contract.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.contract.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.failure.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.failure.ExecutionStage;
import io.github.jaeseongs95.portal.domain.failure.RemoteOutcome;
import io.github.jaeseongs95.portal.domain.file.FileBinding;
import io.github.jaeseongs95.portal.domain.file.FileName;
import io.github.jaeseongs95.portal.domain.file.FileTargetBinding;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OperationIdGenerator;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.AgentCliInput;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.DownloadInput;
import io.github.jaeseongs95.portal.domain.operation.Elevation;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationEvent;
import io.github.jaeseongs95.portal.domain.operation.OperationInput;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.OutcomeCertainty;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.operation.ReconciliationEvidence;
import io.github.jaeseongs95.portal.domain.operation.RecordedResult;
import io.github.jaeseongs95.portal.domain.operation.Settlement;
import io.github.jaeseongs95.portal.domain.operation.SourceInput;
import io.github.jaeseongs95.portal.domain.operation.UploadInput;
import io.github.jaeseongs95.portal.domain.operation.UploadProtocol;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;

@JournalTest
class JdbcOperationJournalTest {

    private final JdbcOperationJournal journal;
    private final JdbcClaimStore claims;
    private final OperationRowRepository operations;
    private final OperationEventRowRepository events;
    private final OperationLegacyRowRepository legacy;
    private final OperationStorage storage;
    private final OperationIdGenerator ids;
    private final Clock clock;
    private final PlatformTransactionManager transactions;
    private final Digester digester;
    private final JournalFixture fx = new JournalFixture();

    JdbcOperationJournalTest(JdbcOperationJournal journal, JdbcClaimStore claims, OperationRowRepository operations, OperationEventRowRepository events,
                             OperationLegacyRowRepository legacy, OperationStorage storage, OperationIdGenerator ids, Clock clock, PlatformTransactionManager transactions,
                             Digester digester) {
        this.journal = journal;
        this.claims = claims;
        this.operations = operations;
        this.events = events;
        this.legacy = legacy;
        this.storage = storage;
        this.ids = ids;
        this.clock = clock;
        this.transactions = transactions;
        this.digester = digester;
    }

    private void assertConflict(NewOperation changed) {
        assertThatThrownBy(() -> journal.accept(changed)).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(RequestErrorCode.OPERATION_KEY_CONFLICT));
    }

    @Test
    @DisplayName("RC-B-201 and S2-DB-04: the same contract is the same operation, a changed contract is OPERATION_KEY_CONFLICT, and the stored copy is the operation of the first intake")
    void theSameContractIsTheSameOperation() {
        NewOperation spec = fx.command("same", "alpha", "printf ok", new ConflictKey.None());
        JournalInsert first = journal.accept(spec);
        JournalInsert second = journal.accept(spec);

        assertThat(first).isInstanceOf(JournalInsert.Inserted.class);
        assertThat(second).isInstanceOf(JournalInsert.Existing.class);
        assertThat(second.operation().id()).isEqualTo(first.operation().id());
        assertThat(journal.find(first.operation().id()).orElseThrow().snapshot()).isEqualTo(first.operation().snapshot());

        assertConflict(fx.command("same", "alpha", "printf ok ", new ConflictKey.None()));
        assertConflict(fx.command("same", "alpha", "printf ok", "other", JournalFixture.REVISION, new ConflictKey.None(), new Deadline.None()));
        assertConflict(fx.command("same", "alpha", "printf ok", "owner", "1".repeat(64), new ConflictKey.None(), new Deadline.None()));
        assertConflict(fx.command("same", "alpha", "printf ok", "owner", JournalFixture.REVISION, new ConflictKey.None(),
            new Deadline.At(JournalFixture.NOW.plus(Duration.ofMinutes(30)))));

        assertThat(journal.findByRequestKey(fx.requestKey("same")).orElseThrow().id()).isEqualTo(first.operation().id());
        assertThat(journal.events(first.operation().id()).stream().map(OperationEvent::state)).containsExactly(OperationState.ACCEPTED);
    }

    @Test
    @DisplayName("RC-A-426: the request key is kept: submitting it again gives the same operation and the changed arguments are refused")
    void theRequestKeyIsKept() {
        Operation first = journal.accept(fx.command("fixture-request-0001", "alpha", "sudo id", new ConflictKey.None())).operation();
        assertThat(journal.accept(fx.command("fixture-request-0001", "alpha", "sudo id", new ConflictKey.None())).operation().id()).isEqualTo(first.id());
        assertConflict(fx.command("fixture-request-0001", "alpha", "sudo pwd", new ConflictKey.None()));
    }

    @Test
    @DisplayName("S2-DB-03: two writers that read the same version: the first transition is stored, the second is OPERATION_VERSION_CONFLICT and changes nothing")
    void theSecondWriterOfAVersionLoses() {
        Operation accepted = journal.accept(fx.command("race", "alpha", "echo", new ConflictKey.None())).operation();
        Operation staleCopy = journal.find(accepted.id()).orElseThrow();

        Operation pending = journal.save(accepted.awaitOwnerDecision(JournalFixture.NOW), accepted.version());

        assertThatThrownBy(() -> journal.save(staleCopy.beginEvaluation(JournalFixture.NOW), staleCopy.version())).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(OperationErrorCode.OPERATION_VERSION_CONFLICT));
        assertThat(journal.find(accepted.id()).orElseThrow().snapshot()).isEqualTo(pending.snapshot());
        assertThat(journal.events(accepted.id()).stream().map(OperationEvent::version)).containsExactly(1L, 2L);
    }

    @Test
    @DisplayName("RC-B-202: a transition that did not pass the claim cannot move an operation into STARTING (it would take a slot nobody counted)")
    void saveRefusesAClaimThatSkippedTheLimits() {
        Operation queued = fx.queued(journal, fx.command("skip", "alpha", "echo", new ConflictKey.None()));
        assertThatThrownBy(() -> journal.save(queued.claim(JournalFixture.NOW), queued.version())).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(OperationErrorCode.INVALID_OPERATION_TRANSITION));
    }

    @Test
    @DisplayName("RC-B-207: a journal that holds its limit of rows refuses a new intake with OPERATION_CAPACITY and stores nothing of it")
    void theJournalRefusesAnIntakeBeyondItsLimit() {
        JdbcOperationJournal small = new JdbcOperationJournal(operations, events, legacy, storage, ids, clock, transactions, 3);
        small.accept(fx.command("one", "alpha", "echo 1", new ConflictKey.None()));
        small.accept(fx.command("two", "alpha", "echo 2", new ConflictKey.None()));
        small.accept(fx.command("three", "alpha", "echo 3", new ConflictKey.None()));
        NewOperation overflow = fx.command("overflow", "alpha", "echo 4", new ConflictKey.None());

        assertThatThrownBy(() -> small.accept(overflow)).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(OperationErrorCode.OPERATION_CAPACITY));
        assertThat(small.findByRequestKey(overflow.requestKey())).isEmpty();
        // The limit refuses new rows only: a key that is stored is still answered.
        assertThat(small.accept(fx.command("one", "alpha", "echo 1", new ConflictKey.None()))).isInstanceOf(JournalInsert.Existing.class);
    }

    @Test
    @DisplayName("RC-B-204: an executed outcome is stored with the state its verdict gives, and the stored operation is the same value when it is read again")
    void theOutcomeDecidesTheStoredState() {
        Operation running = running("done");
        ExecutionOutcome exited = ExecutionOutcome.exited(0, List.of("ok"));
        Operation completed = journal.save(running.settle(exited, JournalFixture.NOW.plusSeconds(5)), running.version());

        assertThat(completed.state()).isEqualTo(OperationState.COMPLETED);
        Operation read = journal.find(completed.id()).orElseThrow();
        assertThat(read.snapshot()).isEqualTo(completed.snapshot());
        assertThat(read.settlement()).isInstanceOfSatisfying(Settlement.Settled.class, settled -> {
            assertThat(settled.certainty()).isEqualTo(OutcomeCertainty.EXITED);
            assertThat(settled.result()).isEqualTo(new RecordedResult.Executed(exited));
        });
    }

    @Test
    @DisplayName("RC-B-204: a lost transport is stored as UNKNOWN with the reconciliation required; reconciling it is stored as a final state and the result is kept")
    void anUnprovenOutcomeIsUnknownUntilItIsReconciled() {
        Operation running = running("lost");
        ExecutionFailure failure = new ExecutionFailure.Classified(ExecutionStage.SSH_EXECUTION, ExecutionErrorCode.SSH_EXECUTION_FAILED, RemoteOutcome.UNKNOWN);
        ExecutionOutcome lost = ExecutionOutcome.transportLost(failure, List.of("connection lost"));
        Operation unknown = journal.save(running.settle(lost, JournalFixture.NOW.plusSeconds(5)), running.version());

        assertThat(unknown.state()).isEqualTo(OperationState.UNKNOWN);
        assertThat(journal.find(unknown.id()).orElseThrow().snapshot()).isEqualTo(unknown.snapshot());

        Operation reconciled = journal.save(unknown.reconcile(new ReconciliationEvidence.Failed(), JournalFixture.NOW.plusSeconds(60)), unknown.version());
        assertThat(reconciled.state()).isEqualTo(OperationState.FAILED);
        assertThat(journal.find(unknown.id()).orElseThrow().snapshot()).isEqualTo(reconciled.snapshot());
        assertThat(journal.events(unknown.id()).stream().map(OperationEvent::state)).endsWith(OperationState.RUNNING, OperationState.UNKNOWN, OperationState.FAILED);
    }

    @Test
    @DisplayName("S2-ST-05: every kind of input is stored and read back as the same value (source, upload with and without binding, download, agent CLI)")
    void everyInputKindRoundTrips() {
        Digest hex = new Digest("1".repeat(64));
        List<OperationInput> inputs = List.of(
            new SourceInput(new CommandText("python3 -"), hex, hex, 5, new Utf8Text("[\"a\"]"), new Utf8Text("/tmp"), Elevation.SUDO, hex, new Utf8Text("c"), new Utf8Text("d")),
            new UploadInput(new ArtifactId("2".repeat(48)), RemotePath.parse("/tmp/a.txt"), new FileName("a.txt"), 10, hex, OverwriteMode.FAIL_IF_EXISTS, Elevation.NONE,
                new FileBinding.Bound(new FileTargetBinding(new TargetId("alpha"), TargetRevision.of("0".repeat(64)))), UploadProtocol.MCP_JSON_V1),
            new UploadInput(new ArtifactId("3".repeat(48)), RemotePath.parse("C:\\data\\a.txt"), new FileName("a.txt"), 0, hex, OverwriteMode.REPLACE, Elevation.NONE,
                new FileBinding.Unbound(), UploadProtocol.UNSPECIFIED),
            new DownloadInput(RemotePath.parse("/var/log/x"), Elevation.SUDO, new FileBinding.Unbound(), new Utf8Text("c"), new Utf8Text("d")),
            new AgentCliInput(hex));
        int number = 0;
        for (OperationInput input : inputs) {
            NewOperation spec = NewOperation.of(digester, fx.requestKey("kind" + number++), new OwnerId("owner"), new TargetId("alpha"), TargetRevision.of(JournalFixture.REVISION),
                new ProfileAlias("default"), input, new ConflictKey.Of("one"), new Deadline.None());
            Operation accepted = journal.accept(spec).operation();
            assertThat(journal.find(accepted.id()).orElseThrow().snapshot()).as(input.getClass().getSimpleName()).isEqualTo(accepted.snapshot());
        }
    }

    @Test
    @DisplayName("S2-ST-05: the contract of a stored operation is the same after every transition")
    void theContractDoesNotChange() {
        NewOperation spec = fx.command("contract", "alpha", "echo", new ConflictKey.Of("k"));
        Operation queued = fx.queued(journal, spec);

        assertThat(queued.state()).isEqualTo(OperationState.QUEUED);
        assertThat(journal.find(queued.id()).orElseThrow().contractDigest()).isEqualTo(spec.contractDigest());
        assertThat(journal.find(queued.id()).orElseThrow().requestKey()).isEqualTo(spec.requestKey());
        assertThat(journal.find(queued.id()).orElseThrow().input()).isEqualTo(spec.input());
    }

    @Test
    @DisplayName("S2-DB-07: an Instant that is stored and read under a JVM time zone that is not UTC comes back as the same Instant")
    void instantsSurviveANonUtcZone() {
        TimeZone before = TimeZone.getDefault();
        try {
            int number = 0;
            for (String zone : List.of("Asia/Seoul", "Pacific/Auckland", "America/Los_Angeles")) {
                TimeZone.setDefault(TimeZone.getTimeZone(zone));
                Instant moment = Instant.parse("2027-07-01T12:34:56.123456Z");
                Operation accepted = journal.accept(fx.command("zone" + number++, "alpha", "echo " + zone, new ConflictKey.None())).operation();
                Operation moved = journal.save(accepted.awaitOwnerDecision(moment), accepted.version());
                assertThat(journal.find(moved.id()).orElseThrow().updatedAt()).as(zone).isEqualTo(moment);
                assertThat(journal.find(moved.id()).orElseThrow().createdAt()).as(zone).isEqualTo(accepted.createdAt());
            }
        } finally {
            TimeZone.setDefault(before);
        }
    }

    private Operation running(String key) {
        Operation queued = fx.queued(journal, fx.command(key, "alpha", "echo " + key, new ConflictKey.None()));
        ClaimResult claimed = claims.claim(queued.id(), queued.version(), ConcurrencyLimits.defaults(), JournalFixture.NOW.plusSeconds(2));
        assertThat(claimed).isInstanceOf(ClaimResult.Claimed.class);
        Operation starting = ((ClaimResult.Claimed) claimed).operation();
        return journal.save(starting.markRunning(JournalFixture.NOW.plusSeconds(3)), starting.version());
    }
}
