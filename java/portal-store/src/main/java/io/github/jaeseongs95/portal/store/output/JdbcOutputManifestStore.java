package io.github.jaeseongs95.portal.store.output;

import java.time.Instant;
import java.util.List;
import java.util.Objects;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.jdbc.core.JdbcAggregateOperations;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import io.github.jaeseongs95.portal.app.output.OutputBinding;
import io.github.jaeseongs95.portal.app.output.OutputBudget;
import io.github.jaeseongs95.portal.app.output.OutputFormats;
import io.github.jaeseongs95.portal.app.output.OutputId;
import io.github.jaeseongs95.portal.app.output.OutputLookup;
import io.github.jaeseongs95.portal.app.output.OutputManifest;
import io.github.jaeseongs95.portal.app.output.OutputManifestStore;
import io.github.jaeseongs95.portal.app.output.OutputPayloadStore;
import io.github.jaeseongs95.portal.app.output.OutputReservation;
import io.github.jaeseongs95.portal.app.output.OutputState;
import io.github.jaeseongs95.portal.app.output.StreamInfo;
import io.github.jaeseongs95.portal.app.storage.DiskSpace;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.OperationIdGenerator;

/**
 * {@link OutputManifestStore} over {@code command_output}, {@code command_output_format} and {@code command_output_page} (design 8.2 V3, 2.x {@code command-output.mjs}
 * table {@code outputs}). The payload bytes are not here: the two methods that need a fact about the files ({@link #reserve} wants the free disk space,
 * {@link #markUnavailable} the bytes the files hold) ask the {@link OutputPayloadStore} <em>before</em> their transaction starts, and the transaction itself does no
 * file I/O (Principles 4.4); every other method is one short {@code @Transactional} method.
 *
 * <p>A change of a row is a compare-and-set on {@code version}: {@link CommandOutputRowRepository#bumpVersion} moves the version in the same transaction, and a
 * writer that lost the race is refused with {@link ExecutionErrorCode#OUTPUT_CAPTURE_FAILED}. A write to an output that is missing or in the wrong state is refused
 * with the same code (the capture of that output failed). The budget check of {@link #reserve} reads the sum of the charges and writes the new row in one
 * transaction; the dispatcher is a single scheduler thread (design 13.2), so two reservations do not race, and an overrun by a concurrent second writer would be one
 * output.
 */
@Repository
public class JdbcOutputManifestStore implements OutputManifestStore {

    private static final Logger LOG = LoggerFactory.getLogger(JdbcOutputManifestStore.class);

    /** What the files of an output hold, or that this could not be measured safely. */
    private sealed interface Retained permits Measured, Unmeasured {
    }

    private record Measured(long bytes) implements Retained {
    }

    private record Unmeasured() implements Retained {
    }

    private final CommandOutputRowRepository outputs;
    private final CommandOutputFormatRowRepository formats;
    private final CommandOutputPageRowRepository pages;
    private final JdbcAggregateOperations aggregates;
    private final OutputMapper mapper;
    private final OperationIdGenerator ids;
    private final OutputPayloadStore payloads;
    private final TransactionTemplate transaction;
    private final OutputLimits limits;

    public JdbcOutputManifestStore(CommandOutputRowRepository outputs, CommandOutputFormatRowRepository formats, CommandOutputPageRowRepository pages,
                                   JdbcAggregateOperations aggregates, OutputMapper mapper, OperationIdGenerator ids, OutputPayloadStore payloads,
                                   PlatformTransactionManager transactionManager, OutputLimits limits) {
        this.outputs = outputs;
        this.formats = formats;
        this.pages = pages;
        this.aggregates = aggregates;
        this.mapper = mapper;
        this.ids = ids;
        this.payloads = payloads;
        this.transaction = new TransactionTemplate(transactionManager);
        this.limits = limits;
    }

    @Override
    @Transactional(readOnly = true)
    public OutputLookup find(OutputId id, Instant now) {
        return outputs.findById(id.value()).map(row -> lookup(row, now)).orElseGet(OutputLookup.Missing::new);
    }

    /**
     * Checks, in this order: the size of one output ({@code TooLarge}), the number of outputs ({@code CountExceeded}), the budget ({@code BudgetExceeded}) and the free
     * disk space ({@code DiskSpaceInsufficient}: the per-output limit plus the margin, as in 2.x). A refusal creates no row. Rows that have expired but are not removed
     * yet still count; removing them is the reaper's job ({@link OutputStartupCheck#reap}), which a caller runs first when it is allowed to.
     */
    @Override
    public OutputReservation reserve(OutputBinding binding, long expectedBytes, Instant at) {
        Objects.requireNonNull(binding, "binding");
        Objects.requireNonNull(at, "at");
        if (expectedBytes < 0) {
            throw new IllegalArgumentException("expectedBytes must not be negative: " + expectedBytes);
        }
        DiskSpace disk = payloads.usable();
        return Objects.requireNonNull(transaction.execute(status -> reserveRow(binding, expectedBytes, at, disk)));
    }

    @Override
    @Transactional
    public OutputManifest recordStream(OutputId id, StreamInfo stream) {
        if (stream instanceof StreamInfo.NoStream) {
            throw new IllegalArgumentException("Record an open or a complete stream; no stream is the state before the first record");
        }
        CommandOutputRow row = requirePending(id);
        if (row.streamState() == StreamState.COMPLETE) {
            throw new RequestRefusedException(ExecutionErrorCode.OUTPUT_CAPTURE_FAILED);
        }
        CommandOutputRow next = mapper.withStream(claimVersion(row), stream);
        aggregates.update(next);
        return mapper.toManifest(next, List.of(), List.of());
    }

    /** The charge becomes {@code sizeBytes}, the real size of the {@code .out} file (the spool is gone after {@code finish}). The expiry is not renewed. */
    @Override
    @Transactional
    public OutputManifest markReady(OutputId id, OutputFormats formatSpans, long sizeBytes) {
        if (sizeBytes < 0) {
            throw new IllegalArgumentException("sizeBytes must not be negative: " + sizeBytes);
        }
        CommandOutputRow row = requirePending(id);
        List<CommandOutputFormatRow> formatRows = mapper.formatRows(id, formatSpans);
        List<CommandOutputPageRow> pageRows = mapper.pageRows(id, formatSpans);
        CommandOutputRow next = claimVersion(row).withReady(sizeBytes);
        aggregates.update(next);
        aggregates.insertAll(formatRows);
        aggregates.insertAll(pageRows);
        return mapper.toManifest(next, formatRows, pageRows);
    }

    /**
     * Gives the output up and sets its expiry. The charge becomes the bytes the files hold now (an empty reservation is released, partial or oversize evidence is
     * charged in full); when the files cannot be measured safely (a link, another owner, an open mode) the charge stays at the larger of the old charge and the
     * per-output limit, because unmeasurable evidence never proves an empty reservation (2.x {@code retainedCharge}). Calling it again for an output that is already
     * {@code UNAVAILABLE} measures the files again and applies the given expiry; the start-up check uses this to correct an old charge. A {@code READY} output is
     * refused.
     */
    @Override
    public void markUnavailable(OutputId id, Instant expiresAt) {
        Objects.requireNonNull(expiresAt, "expiresAt");
        Retained retained = measure(id);
        transaction.executeWithoutResult(status -> settleUnavailable(id, expiresAt, retained));
    }

    @Override
    @Transactional(readOnly = true)
    public OutputBudget budget() {
        return new OutputBudget(limits.budgetBytes(), outputs.totalCharge(), limits.maxCount(), Math.toIntExact(outputs.count()));
    }

    @Override
    @Transactional(readOnly = true)
    public List<OutputManifest> expired(Instant now) {
        return outputs.findByExpiresAtLessThanEqual(now).stream().map(this::manifest).toList();
    }

    @Override
    @Transactional
    public void delete(OutputId id) {
        pages.removeByOutputId(id.value());
        formats.removeByOutputId(id.value());
        outputs.removeById(id.value());
    }

    /**
     * The outputs in one stored state: the start-up check needs the {@code PENDING} outputs (they were interrupted by the restart) and the {@code UNAVAILABLE} ones
     * (their charge is measured again).
     */
    @Override
    @Transactional(readOnly = true)
    public List<OutputManifest> inState(OutputState state) {
        return outputs.findByState(state).stream().map(this::manifest).toList();
    }

    private OutputLookup lookup(CommandOutputRow row, Instant now) {
        if (!now.isBefore(row.expiresAt())) {
            return new OutputLookup.Expired();
        }
        return switch (row.state()) {
            case PENDING -> new OutputLookup.Pending();
            case UNAVAILABLE -> new OutputLookup.Unavailable();
            case READY -> new OutputLookup.Ready(manifest(row));
        };
    }

    private OutputManifest manifest(CommandOutputRow row) {
        return mapper.toManifest(row, formats.findByOutputId(row.id()), pages.findByOutputIdOrderByFormatAscPageNoAsc(row.id()));
    }

    private OutputReservation reserveRow(OutputBinding binding, long expectedBytes, Instant at, DiskSpace disk) {
        if (expectedBytes > limits.maxOutputBytes()) {
            return new OutputReservation.TooLarge(limits.maxOutputBytes());
        }
        if (outputs.count() >= limits.maxCount()) {
            return new OutputReservation.CountExceeded(limits.maxCount());
        }
        long charged = outputs.totalCharge();
        if (charged + expectedBytes > limits.budgetBytes()) {
            return new OutputReservation.BudgetExceeded(expectedBytes, charged, limits.budgetBytes());
        }
        if (disk.usableBytes() < limits.diskRequiredBytes()) {
            return new OutputReservation.DiskSpaceInsufficient(limits.diskRequiredBytes(), disk.usableBytes());
        }
        // The id has the format of every identifier of the contract, which the operation id generator makes (24 random bytes as 48 hex characters).
        OutputId id = new OutputId(ids.next().value());
        aggregates.insert(mapper.newRow(id, binding, at.plus(limits.ttl()), expectedBytes));
        return new OutputReservation.Reserved(id);
    }

    private Retained measure(OutputId id) {
        try {
            return new Measured(payloads.retainedBytes(id));
        } catch (RequestRefusedException e) {
            LOG.warn("The bytes of output {} cannot be measured safely; its charge stays conservative", id.value(), e);
            return new Unmeasured();
        }
    }

    private void settleUnavailable(OutputId id, Instant expiresAt, Retained retained) {
        CommandOutputRow row = requireRow(id);
        if (row.state() == OutputState.READY) {
            throw new RequestRefusedException(ExecutionErrorCode.OUTPUT_CAPTURE_FAILED);
        }
        long charge = switch (retained) {
            case Measured measured -> measured.bytes();
            case Unmeasured unmeasured -> Math.max(row.chargeBytes(), limits.maxOutputBytes());
        };
        if (row.state() == OutputState.UNAVAILABLE && row.expiresAt().equals(expiresAt) && row.chargeBytes() == charge) {
            return;
        }
        aggregates.update(claimVersion(row).withUnavailable(expiresAt, charge));
    }

    private CommandOutputRow requireRow(OutputId id) {
        return outputs.findById(id.value()).orElseThrow(() -> new RequestRefusedException(ExecutionErrorCode.OUTPUT_CAPTURE_FAILED));
    }

    private CommandOutputRow requirePending(OutputId id) {
        CommandOutputRow row = requireRow(id);
        if (row.state() != OutputState.PENDING) {
            throw new RequestRefusedException(ExecutionErrorCode.OUTPUT_CAPTURE_FAILED);
        }
        return row;
    }

    /** The compare-and-set: moves the version by one, or refuses because another writer changed the row first. */
    private CommandOutputRow claimVersion(CommandOutputRow row) {
        long next = row.version() + 1;
        if (outputs.bumpVersion(row.id(), row.version(), next) != 1) {
            throw new RequestRefusedException(ExecutionErrorCode.OUTPUT_CAPTURE_FAILED);
        }
        return row.withVersion(next);
    }
}
