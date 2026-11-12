package io.github.jaeseongs95.portal.store.journal;

import java.time.Instant;
import java.util.Arrays;
import java.util.EnumSet;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

import org.springframework.data.jdbc.core.JdbcAggregateOperations;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.domain.contract.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.operation.AgentCliInput;
import io.github.jaeseongs95.portal.domain.operation.CommandInput;
import io.github.jaeseongs95.portal.domain.operation.DecisionRecord;
import io.github.jaeseongs95.portal.domain.operation.DownloadInput;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationInput;
import io.github.jaeseongs95.portal.domain.operation.OperationSnapshot;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.RecordedResult;
import io.github.jaeseongs95.portal.domain.operation.Settlement;
import io.github.jaeseongs95.portal.domain.operation.SourceInput;
import io.github.jaeseongs95.portal.domain.operation.UploadInput;

/**
 * The reading and writing of one operation across the tables of the journal. The adapters of the journal ({@code JdbcOperationJournal}, {@code JdbcClaimStore},
 * {@code JdbcRestartRecovery}, the views) call it inside their own transactions; it declares none itself, so it joins the caller's.
 *
 * <p>Writing is a compare-and-set in two steps (design 8.7, 13.2): {@code UPDATE operation SET version = next WHERE id = ? AND version = expected} takes the row
 * lock and checks the version in one statement, then the rest of the row and the child rows are written. No {@code @Version} annotation is used: its initial value and
 * its increment are not what the domain's version (starting at 1, plus one per transition) is. The slots and the fence are released here in the same transaction as the
 * state that frees them, so a limit is never held by an operation that left the active states.
 */
@Component
class OperationStorage {

    /** The states that hold concurrency slots: derived from the domain's {@code isActive()} so that the two cannot drift apart. */
    static final Set<OperationState> ACTIVE_STATES = Arrays.stream(OperationState.values()).filter(OperationState::isActive)
        .collect(Collectors.toCollection(() -> EnumSet.noneOf(OperationState.class)));

    private final OperationRowRepository operations;
    private final OperationEventRowRepository events;
    private final OperationCommandRowRepository commands;
    private final OperationSourceRowRepository sources;
    private final OperationUploadRowRepository uploads;
    private final OperationDownloadRowRepository downloads;
    private final OperationDecisionRowRepository decisions;
    private final OperationResultRowRepository results;
    private final OperationSlotRowRepository slots;
    private final OperationFenceRowRepository fences;
    private final JdbcAggregateOperations aggregates;
    private final OperationMapper mapper;

    OperationStorage(OperationRowRepository operations, OperationEventRowRepository events, OperationCommandRowRepository commands, OperationSourceRowRepository sources,
                     OperationUploadRowRepository uploads, OperationDownloadRowRepository downloads, OperationDecisionRowRepository decisions,
                     OperationResultRowRepository results, OperationSlotRowRepository slots, OperationFenceRowRepository fences, JdbcAggregateOperations aggregates,
                     OperationMapper mapper) {
        this.operations = operations;
        this.events = events;
        this.commands = commands;
        this.sources = sources;
        this.uploads = uploads;
        this.downloads = downloads;
        this.decisions = decisions;
        this.results = results;
        this.slots = slots;
        this.fences = fences;
        this.aggregates = aggregates;
        this.mapper = mapper;
    }

    /** Builds the domain object of a stored row from its input, decision and result rows; a row whose parts are missing is refused as {@code INVALID_OPERATION_RECORD}. */
    Operation load(OperationRow row) {
        String id = row.id();
        OperationInput input = switch (row.kind()) {
            case COMMAND -> mapper.commandInput(commands.findById(id).orElseThrow(OperationStorage::brokenRecord));
            case SOURCE -> mapper.sourceInput(sources.findById(id).orElseThrow(OperationStorage::brokenRecord));
            case UPLOAD -> mapper.uploadInput(uploads.findById(id).orElseThrow(OperationStorage::brokenRecord));
            case DOWNLOAD -> mapper.downloadInput(downloads.findById(id).orElseThrow(OperationStorage::brokenRecord));
            case AGENT_CLI -> mapper.agentCliInput(row);
        };
        DecisionRecord decision = decisions.findById(id).<DecisionRecord>map(mapper::decision).orElseGet(DecisionRecord.NoDecision::new);
        RecordedResult result = row.outcomeCertainty() == null ? new RecordedResult.NoResult()
            : results.findById(id).<RecordedResult>map(mapper::result).orElseGet(RecordedResult.NoResult::new);
        return Operation.restore(mapper.snapshot(row, input, decision, result));
    }

    /** Inserts a new operation: its row, its input rows and the event of its first version. */
    void insertNew(Operation operation) {
        OperationSnapshot s = operation.snapshot();
        aggregates.insert(mapper.operationRow(s, null, null, null));
        switch (s.input()) {
            case CommandInput command -> aggregates.insert(mapper.commandRow(s.id(), command));
            case SourceInput source -> aggregates.insert(mapper.sourceRow(s.id(), source));
            case UploadInput upload -> aggregates.insert(mapper.uploadRow(s.id(), upload));
            case DownloadInput download -> aggregates.insert(mapper.downloadRow(s.id(), download));
            case AgentCliInput agentCli -> {
                // The digest of the intent is the column input_digest of the operation row; the rest of the install is AgentCliRequestStore's.
            }
        }
        aggregates.insert(new OperationEventRow(s.id().value(), s.version(), s.state(), s.updatedAt()));
    }

    /**
     * Stores the next version of an operation. {@code before} is the row as the caller read it at {@code expectedVersion}. Throws
     * {@code RequestRefusedException(OPERATION_VERSION_CONFLICT)} when the stored version is another one.
     */
    Operation persist(OperationRow before, Operation next, long expectedVersion) {
        OperationSnapshot s = next.snapshot();
        if (s.version() != expectedVersion + 1) {
            throw new IllegalArgumentException("The next version must be " + (expectedVersion + 1) + " but is " + s.version());
        }
        if (operations.bumpVersion(before.id(), expectedVersion, s.version()) != 1) {
            throw new RequestRefusedException(OperationErrorCode.OPERATION_VERSION_CONFLICT);
        }
        Long readySequence = before.readySequence();
        Instant readyAt = before.readyAt();
        Instant startedAt = before.startedAt();
        switch (s.state()) {
            case QUEUED -> {
                readySequence = operations.maxReadySequence() + 1;
                readyAt = s.updatedAt();
            }
            case STARTING -> startedAt = s.updatedAt();
            case ACCEPTED, PENDING, EVALUATING, RUNNING, TERMINATING, COMPLETED, FAILED, CANCELLED, DENIED, EXPIRED, UNKNOWN -> {
                // The ready position and the start belong to the transitions into QUEUED and STARTING only.
            }
        }
        aggregates.update(mapper.operationRow(s, readySequence, readyAt, startedAt));
        writeDecision(s);
        writeResult(s);
        aggregates.insert(new OperationEventRow(s.id().value(), s.version(), s.state(), s.updatedAt()));
        if (before.state().isActive() && !s.state().isActive()) {
            slots.deleteByOperation(before.id());
        }
        if (s.state().isFinal()) {
            fences.deleteByOperation(before.id());
        }
        return next;
    }

    private void writeDecision(OperationSnapshot s) {
        if (!(s.decision() instanceof DecisionRecord.Decided decided)) {
            return;
        }
        OperationDecisionRow row = mapper.decisionRow(s.id(), decided);
        Optional<OperationDecisionRow> stored = decisions.findById(s.id().value());
        if (stored.filter(row::equals).isPresent()) {
            return;
        }
        stored.ifPresent(old -> decisions.deleteById(old.operationId()));
        aggregates.insert(row);
    }

    private void writeResult(OperationSnapshot s) {
        if (!(s.settlement() instanceof Settlement.Settled settled)) {
            return;
        }
        OperationResultRow row = switch (settled.result()) {
            case RecordedResult.NoResult noResult -> null;
            case RecordedResult.Executed executed -> mapper.resultRow(s.id(), executed);
            case RecordedResult.Refused refused -> mapper.resultRow(s.id(), refused);
        };
        if (row == null) {
            return;
        }
        Optional<OperationResultRow> stored = results.findById(s.id().value());
        if (stored.filter(row::equals).isPresent()) {
            return;
        }
        stored.ifPresent(old -> results.deleteById(old.operationId()));
        aggregates.insert(row);
    }

    private static RequestRefusedException brokenRecord() {
        return new RequestRefusedException(OperationErrorCode.INVALID_OPERATION_RECORD);
    }
}
