package io.github.jaeseongs95.portal.store.artifact;

import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.jdbc.core.JdbcAggregateOperations;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import io.github.jaeseongs95.portal.app.artifact.ArtifactBudget;
import io.github.jaeseongs95.portal.app.artifact.ArtifactDirection;
import io.github.jaeseongs95.portal.app.artifact.ArtifactPayloadStore;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRecord;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRegistry;
import io.github.jaeseongs95.portal.app.artifact.ArtifactReservation;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRetention;
import io.github.jaeseongs95.portal.app.artifact.ArtifactSpec;
import io.github.jaeseongs95.portal.app.artifact.ArtifactState;
import io.github.jaeseongs95.portal.app.artifact.ChunkDigest;
import io.github.jaeseongs95.portal.app.artifact.ConsumeReason;
import io.github.jaeseongs95.portal.app.artifact.ReleaseReason;
import io.github.jaeseongs95.portal.app.artifact.ReservedSplit;
import io.github.jaeseongs95.portal.app.artifact.StagedAction;
import io.github.jaeseongs95.portal.app.artifact.StagedActionState;
import io.github.jaeseongs95.portal.app.artifact.UnpinReason;
import io.github.jaeseongs95.portal.app.storage.DiskSpace;
import io.github.jaeseongs95.portal.domain.error.ArtifactErrorCode;
import io.github.jaeseongs95.portal.domain.error.ErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.ArtifactIdGenerator;
import io.github.jaeseongs95.portal.domain.id.ArtifactUuid;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.OwnerId;

/**
 * {@link ArtifactRegistry} over the tables {@code artifact}, {@code artifact_chunk} and {@code staged_action} (design 8.2 V2, 2.x {@code artifacts.mjs} manifests).
 * No method touches a file: the bytes are {@link ArtifactPayloadStore}'s, written first and forced to disk, and the metadata is committed second, so a crash leaves
 * at worst a byte tail that {@link ArtifactStartupCheck} cuts off (design 8.5). The one disk read here, the usable space for a reservation, is made
 * <em>before</em> the transaction opens (Principles 4.4), which is why {@link #reserve} drives a {@link TransactionTemplate} and is not itself {@code @Transactional}.
 *
 * <p>Every change of a row first takes the optimistic lock with one conditional UPDATE of the version (the winner changes one row, a loser none) and then writes
 * the row in the same transaction. The budget is a sum read in the same transaction as the insert; two reservations that run at the same moment on different
 * connections can overshoot it by one file (the guarantee of "READ COMMITTED"; a hard cap would need a lock on a counter row, which no use case has asked for).
 * Refusals the use case must tell apart are returned as {@link ArtifactReservation} variants; every other business failure is a {@link RequestRefusedException}.
 */
@Repository
public class JdbcArtifactRegistry implements ArtifactRegistry {

    private static final Logger LOG = LoggerFactory.getLogger(JdbcArtifactRegistry.class);

    /** The states in which an expired, unpinned artifact is released: not {@code CONSUMING} (in use) and not {@code DELETING} (being removed). */
    private static final List<ArtifactState> RELEASABLE_STATES = List.of(ArtifactState.STAGING, ArtifactState.READY, ArtifactState.CONSUMED);

    private final ArtifactRowRepository artifacts;
    private final ArtifactChunkRowRepository chunks;
    private final StagedActionRowRepository actions;
    private final JdbcAggregateOperations aggregates;
    private final ArtifactMapper mapper;
    private final ArtifactPayloadStore payloads;
    private final RetainedPayloads retained;
    private final ArtifactIdGenerator ids;
    private final ArtifactLimits limits;
    private final TransactionTemplate transaction;

    public JdbcArtifactRegistry(ArtifactRowRepository artifacts, ArtifactChunkRowRepository chunks, StagedActionRowRepository actions,
                                JdbcAggregateOperations aggregates, ArtifactMapper mapper, ArtifactPayloadStore payloads, RetainedPayloads retained,
                                ArtifactIdGenerator ids, ArtifactLimits limits, PlatformTransactionManager transactionManager) {
        this.artifacts = artifacts;
        this.chunks = chunks;
        this.actions = actions;
        this.aggregates = aggregates;
        this.mapper = mapper;
        this.payloads = payloads;
        this.retained = retained;
        this.ids = ids;
        this.limits = limits;
        this.transaction = new TransactionTemplate(transactionManager);
    }

    /**
     * The checks run in the order of design 5.2: the size of the file, the budget, the disk. The disk is read before the transaction opens (file I/O outside a
     * transaction, Principles 4.4) but is only <em>judged</em> after the budget accepted the file, so the budget's verdict never depends on what the disk says, and a
     * disk that cannot be read refuses nothing by itself: it throws {@code ARTIFACT_STORAGE_IO_ERROR} when the file got that far.
     */
    @Override
    public ArtifactReservation reserve(ArtifactSpec spec, Instant at) {
        Objects.requireNonNull(spec, "spec");
        Objects.requireNonNull(at, "at");
        if (spec.sizeBytes() > limits.maxFileBytes()) {
            return new ArtifactReservation.FileTooLarge(spec.sizeBytes(), limits.maxFileBytes());
        }
        // File-system reads, outside the transaction (Principles 4.4).
        DiskReading disk = readDisk();
        long quarantined = retained.retainedBytes();
        return Objects.requireNonNull(transaction.execute(status -> reserveRows(spec, at, disk, quarantined)), "reservation");
    }

    private DiskReading readDisk() {
        try {
            return new DiskReading.Usable(payloads.usable());
        } catch (RuntimeException e) {
            return new DiskReading.Unreadable(e);
        }
    }

    /**
     * The budget is the reserved bytes of the rows plus the bytes in quarantine: both are on the disk of the staging folder (design 13.6, RC-A-170). A refusal tells
     * the two parts apart (defect D-0012), the rows as {@code liveBytes} and the quarantine as {@code holdingBytes}.
     */
    private ArtifactReservation reserveRows(ArtifactSpec spec, Instant at, DiskReading disk, long quarantined) {
        ReservedSplit reserved = new ReservedSplit(artifacts.chargedBytes(), quarantined);
        if (reserved.totalBytes() > limits.budgetBytes() - Math.max(1L, spec.sizeBytes())) {
            return new ArtifactReservation.BudgetExceeded(spec.sizeBytes(), reserved, limits.budgetBytes());
        }
        long usable = disk.usableBytes();
        if (usable - spec.sizeBytes() < limits.diskMarginBytes()) {
            return new ArtifactReservation.DiskSpaceInsufficient(spec.sizeBytes(), usable, limits.diskMarginBytes());
        }
        ArtifactId id = ids.next();
        ArtifactRow row = mapper.toNewRow(id, spec, at);
        try {
            aggregates.insert(row);
        } catch (DuplicateKeyException e) {
            // The public UUID, or the pair (owner, operationKey), exists already.
            throw new RequestRefusedException(RequestErrorCode.OPERATION_KEY_CONFLICT, e);
        }
        return new ArtifactReservation.Reserved(id);
    }

    @Override
    @Transactional
    public ArtifactRecord append(ArtifactId id, int chunkNo, ChunkDigest chunk) {
        Objects.requireNonNull(chunk, "chunk");
        ArtifactRow row = require(id);
        if (row.state() != ArtifactState.STAGING) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_NOT_WRITABLE);
        }
        if (chunk.sizeBytes() > limits.chunkBytes()) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_INVALID_CHUNK);
        }
        if (chunkNo != row.chunkCount()) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_CHUNK_CONFLICT);
        }
        if (row.receivedBytes() + chunk.sizeBytes() > row.sizeBytes()) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_SEQUENCE_OR_SIZE);
        }
        long next = takeLock(row, ArtifactErrorCode.ARTIFACT_CHUNK_CONFLICT);
        aggregates.insert(mapper.toChunkRow(id, chunkNo, chunk));
        ArtifactRow updated = row.withChunk(chunk.sizeBytes(), next);
        aggregates.update(updated);
        return mapper.toRecord(updated);
    }

    @Override
    @Transactional
    public ArtifactRecord markReady(ArtifactId id, Digest sha256) {
        Objects.requireNonNull(sha256, "sha256");
        ArtifactRow row = require(id);
        if (row.state() == ArtifactState.READY) {
            if (Objects.equals(row.sha256(), sha256.hex())) {
                return mapper.toRecord(row);
            }
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_HASH_MISMATCH);
        }
        if (row.state() != ArtifactState.STAGING) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_NOT_WRITABLE);
        }
        if (row.receivedBytes() != row.sizeBytes()) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_INCOMPLETE);
        }
        ArtifactRow updated = row.ready(sha256.hex(), takeLock(row, ArtifactErrorCode.ARTIFACT_CHANGED));
        aggregates.update(updated);
        return mapper.toRecord(updated);
    }

    @Override
    @Transactional
    public ArtifactRecord completeDownload(ArtifactId id, Digest sha256) {
        Objects.requireNonNull(sha256, "sha256");
        ArtifactRow row = require(id);
        if (row.direction() != ArtifactDirection.DOWNLOAD) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_NOT_WRITABLE);
        }
        if (row.state() == ArtifactState.READY) {
            if (Objects.equals(row.sha256(), sha256.hex())) {
                return mapper.toRecord(row);
            }
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_HASH_MISMATCH);
        }
        if (row.state() != ArtifactState.STAGING) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_NOT_WRITABLE);
        }
        ArtifactRow updated = row.downloaded(sha256.hex(), takeLock(row, ArtifactErrorCode.ARTIFACT_CHANGED));
        aggregates.update(updated);
        return mapper.toRecord(updated);
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<ArtifactRecord> find(ArtifactId id) {
        return artifacts.findById(id.value()).map(mapper::toRecord);
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<ArtifactRecord> findStaged(ArtifactUuid publicUuid) {
        return artifacts.findByPublicUuid(publicUuid.text()).map(mapper::toRecord);
    }

    /** Not {@code @Transactional}: the bytes in quarantine are read from the disk first (Principles 4.4), then the rows are summed. */
    @Override
    public ArtifactBudget budget() {
        long quarantined = retained.retainedBytes();
        return new ArtifactBudget(limits.budgetBytes(), artifacts.chargedBytes() + quarantined);
    }

    @Override
    @Transactional(readOnly = true)
    public List<ArtifactRecord> expired(Instant now) {
        Objects.requireNonNull(now, "now");
        return artifacts.findByRetentionAndStateInAndExpiresAtLessThanEqualOrderByExpiresAtAscIdAsc(ArtifactRetention.RELEASABLE, RELEASABLE_STATES, now).stream()
            .map(mapper::toRecord).toList();
    }

    /**
     * Records the operation and pins the artifact for as long as the operation depends on it: a submitted upload does not expire with its 10 minute staging
     * time (2.x kept it for the 1 hour approval window, RC-A-158). The same operation again changes nothing.
     */
    @Override
    @Transactional
    public ArtifactRecord submit(ArtifactId id, OperationId operationId) {
        Objects.requireNonNull(operationId, "operationId");
        ArtifactRow row = require(id);
        if (row.submissionId() != null) {
            if (Objects.equals(row.submissionId(), operationId.value())) {
                return mapper.toRecord(row);
            }
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_ALREADY_SUBMITTED);
        }
        if (row.state() != ArtifactState.READY) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_NOT_READY);
        }
        ArtifactRow updated = row.submittedAs(operationId.value(), takeLock(row, ArtifactErrorCode.ARTIFACT_ALREADY_SUBMITTED));
        aggregates.update(updated);
        return mapper.toRecord(updated);
    }

    /**
     * Gives the artifact back to the expiry calculation once the operation that pinned it is over (S3-AR-07). An artifact that is released already changes nothing,
     * so a repeated call, or a call after a restart, is harmless.
     */
    @Override
    @Transactional
    public ArtifactRecord unpin(ArtifactId id, UnpinReason reason) {
        Objects.requireNonNull(reason, "reason");
        ArtifactRow row = require(id);
        if (row.retention() == ArtifactRetention.RELEASABLE) {
            return mapper.toRecord(row);
        }
        ArtifactRow updated = row.unpinned(takeLock(row, ArtifactErrorCode.ARTIFACT_CHANGED));
        aggregates.update(updated);
        LOG.info("Artifact {} is no longer pinned: {}", id.value(), reason);
        return mapper.toRecord(updated);
    }

    /** The reason is written with the state, in the one UPDATE that moves the row, so no moment exists in which the file is in use for an unknown reason (S3-AR-09). */
    @Override
    @Transactional
    public ArtifactRecord beginConsume(ArtifactId id, ConsumeReason reason) {
        Objects.requireNonNull(reason, "reason");
        ArtifactRow row = require(id);
        switch (row.state()) {
            case READY -> {
                // fall out of the switch: the transition below
            }
            case CONSUMING, CONSUMED -> throw new RequestRefusedException(ArtifactErrorCode.STAGED_FILE_CONSUMED);
            case STAGING, DELETING -> throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_NOT_READY);
        }
        ArtifactRow updated = row.consumingBecause(reason, takeLock(row, ArtifactErrorCode.STAGED_FILE_CONSUMED));
        aggregates.update(updated);
        return mapper.toRecord(updated);
    }

    /**
     * {@code CONSUMING} to {@code CONSUMED}. Asked twice for the same reason, or by two threads at once, it answers the same tombstone: the row charges one byte
     * once (RC-B-095). The reason must be the one that {@link #beginConsume} recorded; a use that began for another reason is never finished under this one.
     */
    @Override
    @Transactional
    public ArtifactRecord completeConsume(ArtifactId id, ConsumeReason reason) {
        Objects.requireNonNull(reason, "reason");
        ArtifactRow row = require(id);
        if (row.state() == ArtifactState.CONSUMED) {
            return answerConsumed(row, reason);
        }
        if (row.state() != ArtifactState.CONSUMING || row.consumeReason() != reason) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_CHANGED);
        }
        long next = row.version() + 1;
        if (artifacts.bumpVersion(row.id(), row.version(), next) != 1) {
            // Another caller moved the row first; the answer is theirs when the reason is the same.
            return answerConsumed(require(id), reason);
        }
        ArtifactRow updated = row.consumedBecause(reason, next);
        aggregates.update(updated);
        return mapper.toRecord(updated);
    }

    private ArtifactRecord answerConsumed(ArtifactRow row, ConsumeReason reason) {
        if (row.state() == ArtifactState.CONSUMED && row.consumeReason() == reason) {
            return mapper.toRecord(row);
        }
        if (row.state() == ArtifactState.CONSUMED) {
            throw new RequestRefusedException(ArtifactErrorCode.STAGED_FILE_CONSUMED);
        }
        throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_CHANGED);
    }

    @Override
    @Transactional
    public ArtifactRecord beginDelete(ArtifactId id) {
        ArtifactRow row = require(id);
        switch (row.state()) {
            case DELETING -> {
                return mapper.toRecord(row);
            }
            case STAGING, READY -> {
                // fall out of the switch: the transition below
            }
            case CONSUMING -> throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_BUSY);
            case CONSUMED -> throw new RequestRefusedException(ArtifactErrorCode.STAGED_FILE_CONSUMED);
        }
        ArtifactRow updated = row.withState(ArtifactState.DELETING, takeLock(row, ArtifactErrorCode.ARTIFACT_CHANGED));
        aggregates.update(updated);
        return mapper.toRecord(updated);
    }

    /**
     * Removes the row and its chunks and actions. The row must not stand for bytes that still exist: it is {@code DELETING} or {@code CONSUMED}, or it never
     * received a byte. An unknown id is a repeated release and changes nothing.
     */
    @Override
    @Transactional
    public void release(ArtifactId id, ReleaseReason reason) {
        Objects.requireNonNull(reason, "reason");
        artifacts.findById(id.value()).ifPresent(row -> removeRows(row, reason));
    }

    private void removeRows(ArtifactRow row, ReleaseReason reason) {
        boolean neverHeldBytes = row.receivedBytes() == 0L && row.state() != ArtifactState.CONSUMING;
        boolean bytesGone = row.state() == ArtifactState.DELETING || row.state() == ArtifactState.CONSUMED || neverHeldBytes;
        if (!bytesGone) {
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_CHANGED);
        }
        actions.deleteAllOf(row.id());
        chunks.deleteAllOf(row.id());
        artifacts.deleteById(row.id());
        LOG.info("Artifact {} released: {}", row.id(), reason);
    }

    @Override
    @Transactional
    public void addAction(StagedAction action) {
        Objects.requireNonNull(action, "action");
        try {
            aggregates.insert(mapper.toActionRow(action));
        } catch (DuplicateKeyException e) {
            throw new RequestRefusedException(ArtifactErrorCode.OPAQUE_ACTION_CONFLICT, e);
        } catch (DataIntegrityViolationException e) {
            // The foreign key: there is no such artifact.
            throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_NOT_FOUND, e);
        }
    }

    @Override
    @Transactional(readOnly = true)
    public List<StagedAction> actions(ArtifactId id) {
        return actions.findByArtifactIdOrderByOperationKey(id.value()).stream().map(mapper::toAction).toList();
    }

    @Override
    @Transactional
    public void updateAction(ArtifactId id, String operationKey, StagedActionState state) {
        Objects.requireNonNull(operationKey, "operationKey");
        Objects.requireNonNull(state, "state");
        StagedActionRow row = actions.findOne(id.value(), operationKey).orElseThrow(() -> new RequestRefusedException(ArtifactErrorCode.ARTIFACT_NOT_FOUND));
        if (row.state() == state) {
            return;
        }
        if (!allowed(row.state(), state)) {
            throw new RequestRefusedException(ArtifactErrorCode.OPAQUE_ACTION_CONFLICT);
        }
        if (actions.moveState(row.artifactId(), row.operationKey(), row.state().name(), state.name()) != 1) {
            throw new RequestRefusedException(ArtifactErrorCode.OPAQUE_ACTION_CONFLICT);
        }
    }

    /** RESERVED goes to SUBMITTED or REFUSED, SUBMITTED to SETTLED or REFUSED; a refused or settled action never moves again (2.x {@code actions[].state}). */
    private boolean allowed(StagedActionState from, StagedActionState to) {
        return switch (from) {
            case RESERVED -> to == StagedActionState.SUBMITTED || to == StagedActionState.REFUSED;
            case SUBMITTED -> to == StagedActionState.SETTLED || to == StagedActionState.REFUSED;
            case REFUSED, SETTLED -> false;
        };
    }

    @Override
    @Transactional(readOnly = true)
    public List<ArtifactRecord> holding() {
        return artifacts.findByStateNot(ArtifactState.CONSUMED).stream().map(mapper::toRecord).toList();
    }

    @Override
    @Transactional(readOnly = true)
    public List<ChunkDigest> chunks(ArtifactId id) {
        return chunks.findByArtifactIdOrderByChunkNo(id.value()).stream().map(mapper::toChunk).toList();
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<ArtifactRecord> findStagedByKey(OwnerId owner, String operationKey) {
        return artifacts.findByOwnerIdAndOperationKey(owner.value(), operationKey).map(mapper::toRecord);
    }

    private ArtifactRow require(ArtifactId id) {
        return artifacts.findById(id.value()).orElseThrow(() -> new RequestRefusedException(ArtifactErrorCode.ARTIFACT_NOT_FOUND));
    }

    /** The CAS step: the version moves from the one read to the next, or the caller lost the race and is refused with {@code conflict}. */
    private long takeLock(ArtifactRow row, ErrorCode conflict) {
        long next = row.version() + 1;
        if (artifacts.bumpVersion(row.id(), row.version(), next) != 1) {
            throw new RequestRefusedException(conflict);
        }
        return next;
    }

    /**
     * What the read of the disk gave, kept until the budget has judged the file. {@link #usableBytes()} is the one place where a read that failed becomes the
     * {@code ARTIFACT_STORAGE_IO_ERROR} of the reservation: it is asked only by a file that the size limit and the budget accepted.
     */
    private sealed interface DiskReading permits DiskReading.Usable, DiskReading.Unreadable {

        long usableBytes();

        record Usable(DiskSpace space) implements DiskReading {

            @Override
            public long usableBytes() {
                return space.usableBytes();
            }
        }

        record Unreadable(RuntimeException cause) implements DiskReading {

            @Override
            public long usableBytes() {
                throw new RequestRefusedException(ArtifactErrorCode.ARTIFACT_STORAGE_IO_ERROR, cause);
            }
        }
    }
}
