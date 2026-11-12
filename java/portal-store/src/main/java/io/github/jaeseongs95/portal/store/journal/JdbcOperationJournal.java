package io.github.jaeseongs95.portal.store.journal;

import java.time.Clock;
import java.util.List;
import java.util.Optional;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import io.github.jaeseongs95.portal.app.journal.JournalInsert;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.domain.contract.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.OperationIdGenerator;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationEvent;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.store.Savepoints;

/**
 * {@link OperationJournal} over the journal tables (design 8.2 V1, 2.x {@code operation-store.mjs}). The id and the time of a new operation are made here from the
 * {@link OperationIdGenerator} and the one {@link Clock}; a transition is stored by {@link OperationStorage#persist}, a compare-and-set on the version.
 *
 * <p>A request key is unique. The first intake wins; a second intake of the same key with the same contract digest returns the stored operation, with another digest it
 * is {@code OPERATION_KEY_CONFLICT}. Two transactions that accept the same key at the same moment meet at the unique key; the loser's insert runs in a nested
 * transaction (a savepoint), so that on PostgreSQL its failure does not abort the surrounding transaction, and then it reads the winner's row.
 */
@Repository
public class JdbcOperationJournal implements OperationJournal {

    /** Rows kept in the journal before a new intake is refused (2.x {@code maxRows 10000}, design D-12); imported 2.x rows do not count. */
    static final long MAX_ROWS = 10_000;

    private final OperationRowRepository operations;
    private final OperationEventRowRepository events;
    private final OperationLegacyRowRepository legacy;
    private final OperationStorage storage;
    private final OperationIdGenerator ids;
    private final Clock clock;
    private final Savepoints savepoints;

    private final long maxRows;

    @Autowired
    public JdbcOperationJournal(OperationRowRepository operations, OperationEventRowRepository events, OperationLegacyRowRepository legacy, OperationStorage storage,
                                OperationIdGenerator ids, Clock clock, Savepoints savepoints) {
        this(operations, events, legacy, storage, ids, clock, savepoints, MAX_ROWS);
    }

    /** The row limit is a parameter so that a test can reach it with a few rows (test RC-B-207). */
    JdbcOperationJournal(OperationRowRepository operations, OperationEventRowRepository events, OperationLegacyRowRepository legacy, OperationStorage storage,
                         OperationIdGenerator ids, Clock clock, Savepoints savepoints, long maxRows) {
        this.maxRows = maxRows;
        this.operations = operations;
        this.events = events;
        this.legacy = legacy;
        this.storage = storage;
        this.ids = ids;
        this.clock = clock;
        this.savepoints = savepoints;
    }

    @Override
    @Transactional
    public JournalInsert accept(NewOperation spec) {
        Optional<OperationRow> known = operations.findByRequestKey(spec.requestKey().value());
        if (known.isPresent()) {
            return answerFor(known.orElseThrow(), spec);
        }
        if (operations.count() - legacy.count() >= maxRows) {
            throw new RequestRefusedException(OperationErrorCode.OPERATION_CAPACITY);
        }
        Operation created = Operation.accept(spec, ids.next(), clock.instant());
        try {
            savepoints.run(() -> storage.insertNew(created));
            return new JournalInsert.Inserted(created);
        } catch (DuplicateKeyException e) {
            OperationRow winner = operations.findByRequestKey(spec.requestKey().value())
                .orElseThrow(() -> new RequestRefusedException(OperationErrorCode.OPERATION_STORE_FAILED, e));
            return answerFor(winner, spec);
        }
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<Operation> find(OperationId id) {
        return operations.findById(id.value()).map(storage::load);
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<Operation> findByRequestKey(RequestKey key) {
        return operations.findByRequestKey(key.value()).map(storage::load);
    }

    @Override
    @Transactional
    public Operation save(Operation next, long expectedVersion) {
        OperationRow before = operations.findById(next.id().value()).orElseThrow(() -> new RequestRefusedException(RequestErrorCode.OPERATION_NOT_FOUND));
        if (before.version() != expectedVersion) {
            throw new RequestRefusedException(OperationErrorCode.OPERATION_VERSION_CONFLICT);
        }
        if (next.state() == OperationState.STARTING && before.state() != OperationState.STARTING) {
            // The limits are kept by the claim; a transition into STARTING that did not pass it would take a slot nobody counted.
            throw new RequestRefusedException(OperationErrorCode.INVALID_OPERATION_TRANSITION);
        }
        try {
            return storage.persist(before, next, expectedVersion);
        } catch (DuplicateKeyException e) {
            // Two operations were queued in the same instant and took the same ready position; this one is told to read again and decide again.
            throw new RequestRefusedException(OperationErrorCode.OPERATION_VERSION_CONFLICT, e);
        }
    }

    @Override
    @Transactional(readOnly = true)
    public List<OperationEvent> events(OperationId id) {
        return events.findByOperationIdOrderByVersionAsc(id.value()).stream().map(row -> new OperationEvent(row.version(), row.state(), row.occurredAt())).toList();
    }

    private JournalInsert answerFor(OperationRow row, NewOperation spec) {
        Operation stored = storage.load(row);
        if (!stored.hasContract(spec.contractDigest())) {
            throw new RequestRefusedException(RequestErrorCode.OPERATION_KEY_CONFLICT);
        }
        return new JournalInsert.Existing(stored);
    }
}
