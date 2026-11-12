package io.github.jaeseongs95.portal.store.journal;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import io.github.jaeseongs95.portal.app.journal.OperationQueueView;
import io.github.jaeseongs95.portal.app.journal.TargetFilter;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.StateCounts;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;
import io.github.jaeseongs95.portal.domain.schedule.FenceKey;
import io.github.jaeseongs95.portal.domain.schedule.QueuedOperation;
import io.github.jaeseongs95.portal.domain.schedule.SchedulingView;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/**
 * {@link OperationQueueView} over the journal tables: the counts and lists the scheduler's decision needs, read in one transaction and handed over as the domain's
 * {@code SchedulingView}. Nothing here decides; the decision is {@code OperationScheduler}'s.
 */
@Repository
public class JdbcOperationQueueView implements OperationQueueView {

    private final OperationRowRepository operations;
    private final OperationFenceRowRepository fences;
    private final OperationStorage storage;
    private final Digester digester;

    public JdbcOperationQueueView(OperationRowRepository operations, OperationFenceRowRepository fences, OperationStorage storage, Digester digester) {
        this.operations = operations;
        this.fences = fences;
        this.storage = storage;
        this.digester = digester;
    }

    @Override
    @Transactional(readOnly = true)
    public SchedulingView schedulingView(ConcurrencyLimits limits, Instant now, int queuedLimit) {
        List<OperationRow> queuedRows = operations.findByStateOrderByReadySequenceAsc(OperationState.QUEUED, PageRequest.ofSize(queuedLimit));
        List<QueuedOperation> queued = new ArrayList<>();
        Set<String> targets = new LinkedHashSet<>();
        for (OperationRow row : queuedRows) {
            targets.add(row.targetId());
            Deadline expiry = row.expiresAt() == null ? new Deadline.None() : new Deadline.At(row.expiresAt());
            ConflictKey conflictKey = row.conflictKey() == null ? new ConflictKey.None() : new ConflictKey.Of(row.conflictKey());
            queued.add(new QueuedOperation(new OperationId(row.id()), row.version(), new TargetId(row.targetId()), TargetRevision.of(row.targetRevision()), conflictKey,
                expiry, row.readySequence()));
        }
        Map<TargetId, Integer> activeByTarget = new HashMap<>();
        Map<TargetId, Instant> lastStartedAt = new HashMap<>();
        for (String target : targets) {
            activeByTarget.put(new TargetId(target), (int) operations.countByTargetIdAndStateIn(target, OperationStorage.ACTIVE_STATES));
            operations.findFirstByTargetIdAndStartedAtIsNotNullOrderByStartedAtDesc(target).ifPresent(row -> lastStartedAt.put(new TargetId(target), row.startedAt()));
        }
        Set<FenceKey> fenced = new HashSet<>();
        for (QueuedOperation entry : queued) {
            if (entry.conflictKey() instanceof ConflictKey.Of key
                && fences.countHolders(entry.targetId().value(), entry.targetRevision().hex(), digester.digestUtf8(key.value()).hex()) > 0) {
                fenced.add(new FenceKey(entry.targetId(), entry.targetRevision(), key.value()));
            }
        }
        int activeTotal = (int) operations.countByStateIn(OperationStorage.ACTIVE_STATES);
        return new SchedulingView(queued, activeTotal, activeByTarget, (int) operations.countLiveUnknown(), lastStartedAt, fenced, limits, now);
    }

    @Override
    @Transactional(readOnly = true)
    public StateCounts counts() {
        Map<OperationState, Integer> counts = new EnumMap<>(OperationState.class);
        for (OperationState state : OperationState.values()) {
            long count = operations.countByState(state);
            if (count > 0) {
                counts.put(state, (int) count);
            }
        }
        return new StateCounts(counts);
    }

    @Override
    @Transactional(readOnly = true)
    public List<Operation> inStates(Set<OperationState> states, TargetFilter filter, int limit) {
        Collection<OperationState> wanted = Set.copyOf(states);
        Pageable page = PageRequest.ofSize(limit);
        List<OperationRow> rows = switch (filter) {
            case TargetFilter.AnyTarget any -> operations.findByStateInOrderByCreatedAtAscIdAsc(wanted, page);
            case TargetFilter.OnlyTarget only -> operations.findByTargetIdAndStateInOrderByCreatedAtAscIdAsc(only.targetId().value(), wanted, page);
        };
        return rows.stream().map(storage::load).toList();
    }
}
