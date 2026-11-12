package io.github.jaeseongs95.portal.store.journal;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Set;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.app.journal.ClaimResult;
import io.github.jaeseongs95.portal.app.journal.TargetFilter;
import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.StateCounts;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;
import io.github.jaeseongs95.portal.domain.schedule.FenceKey;
import io.github.jaeseongs95.portal.domain.schedule.QueuedOperation;
import io.github.jaeseongs95.portal.domain.schedule.SchedulingView;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

@JournalTest
class JdbcOperationQueueViewTest {

    private static final ConcurrencyLimits LIMITS = ConcurrencyLimits.defaults().withGlobalConcurrency(new Capacity(10)).withTargetConcurrency(new Capacity(10));

    private final JdbcOperationJournal journal;
    private final JdbcClaimStore claims;
    private final JdbcOperationQueueView view;
    private final JournalFixture fx = new JournalFixture();

    JdbcOperationQueueViewTest(JdbcOperationJournal journal, JdbcClaimStore claims, JdbcOperationQueueView view) {
        this.journal = journal;
        this.claims = claims;
        this.view = view;
    }

    @Test
    @DisplayName("S2-SC-01 input: the scheduling view lists the queued operations in ready order with their positions, and counts what is active")
    void theViewListsTheQueueInReadyOrder() {
        Operation first = fx.queued(journal, fx.command("first", "alpha", "echo", new ConflictKey.None()));
        Operation second = fx.queued(journal, fx.command("second", "beta", "echo", new ConflictKey.None()));
        Operation third = fx.queued(journal, fx.command("third", "alpha", "echo", new ConflictKey.None()));
        ClaimResult started = claims.claim(first.id(), first.version(), LIMITS, JournalFixture.NOW.plusSeconds(5));
        assertThat(started).isInstanceOf(ClaimResult.Claimed.class);

        SchedulingView snapshot = view.schedulingView(LIMITS, JournalFixture.NOW.plusSeconds(6), 10);

        assertThat(snapshot.queued().stream().map(QueuedOperation::id)).containsExactly(second.id(), third.id());
        assertThat(snapshot.queued().get(0).readySequence()).isLessThan(snapshot.queued().get(1).readySequence());
        assertThat(snapshot.activeTotal()).isEqualTo(1);
        assertThat(snapshot.activeOn(new TargetId("alpha"))).isEqualTo(1);
        assertThat(snapshot.activeOn(new TargetId("beta"))).isZero();
        assertThat(snapshot.lastStartedAt()).containsEntry(new TargetId("alpha"), JournalFixture.NOW.plusSeconds(5));
        assertThat(snapshot.lastStartedAt()).doesNotContainKey(new TargetId("beta"));
        assertThat(snapshot.liveUnknown()).isZero();
        assertThat(snapshot.limits()).isEqualTo(LIMITS);
    }

    @Test
    @DisplayName("S2-SC-02 input: the view reports the conflict keys of queued operations that a live operation holds, and no others")
    void theViewReportsHeldConflictKeys() {
        Operation holder = fx.queued(journal, fx.command("holder", "alpha", "echo", new ConflictKey.Of("installer")));
        fx.queued(journal, fx.command("waiting", "alpha", "echo", new ConflictKey.Of("installer")));
        fx.queued(journal, fx.command("free", "alpha", "echo", new ConflictKey.Of("other")));
        claims.claim(holder.id(), holder.version(), LIMITS, JournalFixture.NOW.plusSeconds(5));

        SchedulingView snapshot = view.schedulingView(LIMITS, JournalFixture.NOW.plusSeconds(6), 10);

        assertThat(snapshot.fenced()).containsExactly(new FenceKey(new TargetId("alpha"), TargetRevision.of(JournalFixture.REVISION), "installer"));
    }

    @Test
    @DisplayName("RC-B-189: the queue limit of the view cuts the list in ready order")
    void theViewCutsTheQueue() {
        for (int number = 0; number < 4; number++) {
            fx.queued(journal, fx.command("q" + number, "alpha", "echo " + number, new ConflictKey.None()));
        }
        assertThat(view.schedulingView(LIMITS, JournalFixture.NOW, 2).queued()).hasSize(2);
    }

    @Test
    @DisplayName("RC-B-192: the counts of the states and the list of the operations of a state and a target")
    void countsAndLists() {
        fx.pending(journal, fx.command("pending", "alpha", "echo", new ConflictKey.None()));
        Operation queuedAlpha = fx.queued(journal, fx.command("qa", "alpha", "echo", new ConflictKey.None()));
        Operation queuedBeta = fx.queued(journal, fx.command("qb", "beta", "echo", new ConflictKey.None()));

        StateCounts counts = view.counts();
        assertThat(counts.of(OperationState.PENDING)).isEqualTo(1);
        assertThat(counts.of(OperationState.QUEUED)).isEqualTo(2);
        assertThat(counts.of(OperationState.RUNNING)).isZero();

        assertThat(view.inStates(Set.of(OperationState.QUEUED), new TargetFilter.AnyTarget(), 10).stream().map(Operation::id)).containsExactlyInAnyOrder(queuedAlpha.id(), queuedBeta.id());
        assertThat(view.inStates(Set.of(OperationState.QUEUED), new TargetFilter.OnlyTarget(new TargetId("beta")), 10).stream().map(Operation::id)).containsExactly(queuedBeta.id());
        assertThat(view.inStates(Set.of(OperationState.QUEUED, OperationState.PENDING), new TargetFilter.AnyTarget(), 2)).hasSize(2);
    }
}
