package io.github.jaeseongs95.portal.app.history;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.app.journal.HistoryCursor;
import io.github.jaeseongs95.portal.app.journal.HistoryFilter;
import io.github.jaeseongs95.portal.app.journal.HistoryPage;
import io.github.jaeseongs95.portal.app.journal.HistoryQuery;
import io.github.jaeseongs95.portal.app.journal.TargetFilter;
import io.github.jaeseongs95.portal.app.target.TargetSource;
import io.github.jaeseongs95.portal.domain.error.HistoryErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.AgentCliInput;
import io.github.jaeseongs95.portal.domain.operation.CommandInput;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationInput;
import io.github.jaeseongs95.portal.domain.operation.StartAuthority;
import io.github.jaeseongs95.portal.domain.target.AccessMode;
import io.github.jaeseongs95.portal.domain.target.AuthMethod;
import io.github.jaeseongs95.portal.domain.target.CapacityOverride;
import io.github.jaeseongs95.portal.domain.target.ConnectionProfile;
import io.github.jaeseongs95.portal.domain.target.DesktopSettings;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;
import io.github.jaeseongs95.portal.domain.target.Setting;
import io.github.jaeseongs95.portal.domain.target.Target;
import io.github.jaeseongs95.portal.domain.target.TargetDisplayName;
import io.github.jaeseongs95.portal.domain.target.TargetLookup;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import io.github.jaeseongs95.portal.domain.target.Toggle;
import io.github.jaeseongs95.portal.domain.target.TtyMode;
import io.github.jaeseongs95.portal.domain.target.WindowsRuntime;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;

/**
 * The history use case on a plain list of operations in the order the query gives them (RC-B-394, RC-B-396, RC-B-397, RC-B-399, S3-UC-02 neighbours): pages of 20 that are
 * walked without a gap or a repeat, targets that are not registered are not listed, the status of the target is told, an installation is listed only while it is bound to
 * the target as it is, and a page that is too large ends early with a cursor that continues after its last entry.
 */
class HistoryServiceTest {

    private static final Instant T0 = Instant.parse("2026-11-12T00:00:00Z");
    private static final Digester DIGESTER = new Sha256Digester();
    private static final TargetId KNOWN = new TargetId("known-1");
    private static final ProfileAlias WRITE = new ProfileAlias("known-rw");

    private final Targets targets = new Targets();

    @Test
    @DisplayName("RC-B-394: 41 operations are walked in pages of 20, 20 and 1, newest first, each once, and the last page has no cursor")
    void pagesAreWalkedWithoutAGapOrARepeat() {
        List<Operation> history = new ArrayList<>();
        for (int i = 41; i >= 1; i--) {
            history.add(command(i, KNOWN, targets.current().revision(), WRITE, "echo " + i));
        }
        HistoryService service = new HistoryService(new ListQuery(history), targets);

        List<OperationId> seen = new ArrayList<>();
        HistoryCursor cursor = new HistoryCursor.FirstPage();
        List<Integer> sizes = new ArrayList<>();
        while (!(cursor instanceof HistoryCursor.End)) {
            HistoryResult page = service.page(new HistoryFilter(Set.of(), new TargetFilter.AnyTarget()), cursor);
            sizes.add(page.entries().size());
            page.entries().forEach(entry -> seen.add(entry.operation().id()));
            cursor = page.next();
        }

        assertThat(sizes).containsExactly(20, 20, 1);
        assertThat(seen).containsExactlyElementsOf(history.stream().map(Operation::id).toList());
    }

    @Test
    @DisplayName("RC-B-399: a page that is too large ends early with a cursor that continues after its last entry, and walking all pages visits 20 large entries once each")
    void aLargePageEndsEarlyAndContinuesExactly() {
        String large = "가".repeat(9000);
        List<Operation> history = new ArrayList<>();
        for (int i = 20; i >= 1; i--) {
            history.add(command(i, KNOWN, targets.current().revision(), WRITE, large));
        }
        HistoryService service = new HistoryService(new ListQuery(history), targets);

        List<OperationId> seen = new ArrayList<>();
        HistoryCursor cursor = new HistoryCursor.FirstPage();
        int pages = 0;
        while (!(cursor instanceof HistoryCursor.End)) {
            HistoryResult page = service.page(new HistoryFilter(Set.of(), new TargetFilter.AnyTarget()), cursor);
            assertThat(page.entries()).isNotEmpty().hasSizeLessThan(20);
            assertThat(page.entries().stream().mapToLong(entry -> service.weigh(entry.operation())).sum()).isLessThanOrEqualTo(HistoryService.RESPONSE_BYTES);
            page.entries().forEach(entry -> seen.add(entry.operation().id()));
            cursor = page.next();
            pages++;
        }

        assertThat(pages).isGreaterThan(1);
        assertThat(seen).containsExactlyElementsOf(history.stream().map(Operation::id).toList());
    }

    @Test
    @DisplayName("RC-B-399: an entry that is larger than the response limit by itself is HISTORY_ENTRY_TOO_LARGE, in a page and when read alone")
    void anEntryThatAloneIsTooLargeIsRefused() {
        Operation big = settledWithTexts(1, "x".repeat(300_000));
        HistoryService service = new HistoryService(new ListQuery(List.of(big)), targets);

        assertThatThrownBy(() -> service.page(new HistoryFilter(Set.of(), new TargetFilter.AnyTarget()), new HistoryCursor.FirstPage()))
            .isInstanceOfSatisfying(RequestRefusedException.class, e -> assertThat(e.code()).isEqualTo(HistoryErrorCode.HISTORY_ENTRY_TOO_LARGE));
        assertThatThrownBy(() -> service.entry(big.id())).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(HistoryErrorCode.HISTORY_ENTRY_TOO_LARGE));
    }

    @Test
    @DisplayName("RC-B-396: an operation of a target that is no longer registered is not listed; the others tell whether their target is as it ran, changed, or switched off")
    void theTargetStatusIsToldAndUnregisteredTargetsAreLeftOut() {
        Operation active = command(3, KNOWN, targets.current().revision(), WRITE, "echo active");
        Operation changed = command(2, KNOWN, TargetRevision.of("b".repeat(64)), WRITE, "echo changed");
        Operation ghost = command(1, new TargetId("ghost-1"), TargetRevision.of("c".repeat(64)), WRITE, "echo ghost");
        HistoryService service = new HistoryService(new ListQuery(List.of(active, changed, ghost)), targets);

        HistoryResult page = service.page(new HistoryFilter(Set.of(), new TargetFilter.AnyTarget()), new HistoryCursor.FirstPage());
        assertThat(page.entries()).extracting(entry -> entry.operation().id()).containsExactly(active.id(), changed.id());
        assertThat(page.entries()).extracting(HistoryEntry::targetStatus).containsExactly(TargetStatus.ACTIVE, TargetStatus.CHANGED);

        targets.disable();
        assertThat(service.page(new HistoryFilter(Set.of(), new TargetFilter.AnyTarget()), new HistoryCursor.FirstPage()).entries())
            .extracting(HistoryEntry::targetStatus).containsOnly(TargetStatus.DISABLED);
        assertThatThrownBy(() -> service.entry(ghost.id())).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code().name()).isEqualTo("OPERATION_NOT_FOUND"));
    }

    @Test
    @DisplayName("RC-B-397: an agent CLI installation is listed only while its target is enabled with the revision and the write profile it was approved for")
    void anInstallationIsListedOnlyWhileItIsBoundToTheTarget() {
        Operation bound = agentCli(2, targets.current().revision(), WRITE);
        Operation otherRevision = agentCli(1, TargetRevision.of("d".repeat(64)), WRITE);
        Operation otherProfile = agentCli(3, targets.current().revision(), new ProfileAlias("other-rw"));
        HistoryService service = new HistoryService(new ListQuery(List.of(otherProfile, bound, otherRevision)), targets);

        assertThat(service.page(new HistoryFilter(Set.of(), new TargetFilter.AnyTarget()), new HistoryCursor.FirstPage()).entries())
            .extracting(entry -> entry.operation().id()).containsExactly(bound.id());

        targets.disable();
        assertThat(service.page(new HistoryFilter(Set.of(), new TargetFilter.AnyTarget()), new HistoryCursor.FirstPage()).entries()).isEmpty();
    }

    // ---- helpers ----

    private Operation command(int number, TargetId target, TargetRevision revision, ProfileAlias profile, String text) {
        return accept(number, target, revision, profile, new CommandInput(new CommandText(text), new Utf8Text("caller"), new Utf8Text("display")));
    }

    private Operation agentCli(int number, TargetRevision revision, ProfileAlias profile) {
        return accept(number, KNOWN, revision, profile, new AgentCliInput(new Digest("e".repeat(64))));
    }

    private Operation accept(int number, TargetId target, TargetRevision revision, ProfileAlias profile, OperationInput input) {
        RequestKey key = new RequestKey(String.format("history-request-%010d", number));
        NewOperation spec = NewOperation.of(DIGESTER, key, new OwnerId("owner"), target, revision, profile, input, new ConflictKey.None(), new Deadline.None());
        return Operation.accept(spec, new OperationId(String.format("%048x", number)), T0.plusSeconds(number));
    }

    /** An operation that ran and ended with a result whose texts are as large as the test says. */
    private Operation settledWithTexts(int number, String text) {
        Operation accepted = command(number, KNOWN, targets.current().revision(), WRITE, "echo big");
        Operation queued = accepted.awaitOwnerDecision(T0.plusSeconds(100)).enqueue(new StartAuthority.Owner(), T0.plusSeconds(101));
        Operation running = queued.claim(T0.plusSeconds(102)).markRunning(T0.plusSeconds(103));
        return running.settle(ExecutionOutcome.exited(0, List.of(text)), T0.plusSeconds(104));
    }

    /** The one target of the test; it can be switched off. */
    private static final class Targets implements TargetSource {

        private final ResolvedTarget target = build();
        private boolean enabled = true;

        ResolvedTarget current() {
            return target;
        }

        void disable() {
            enabled = false;
        }

        @Override
        public TargetLookup lookup(TargetId id) {
            if (!id.equals(KNOWN)) {
                return new TargetLookup.NotRegistered(id);
            }
            return enabled ? new TargetLookup.Found(target) : new TargetLookup.Disabled(id);
        }

        private static ResolvedTarget build() {
            Target entry = new Target(KNOWN, new TargetDisplayName("Known one"), new ProfileAlias("known-ro"), WRITE, new ProfileAlias("cred1"), Toggle.ON, TargetOs.LINUX,
                WindowsRuntime.none(), new CapacityOverride.Inherited(), new CapacityOverride.Inherited(), new DesktopSettings.NoDesktop());
            return ResolvedTarget.of(entry, profile(AccessMode.READ_ONLY), profile(AccessMode.READ_WRITE), DIGESTER);
        }

        private static ConnectionProfile profile(AccessMode access) {
            return new ConnectionProfile("host.example", 22, "deploy", Setting.given("SHA256:test-host-key"), Setting.unset(), AuthMethod.AGENT, Setting.unset(), Setting.unset(),
                access, TtyMode.NO_TTY);
        }
    }

    /** A history as the query would read it: operations newest first, keyset paging after the position of a cursor. */
    private static final class ListQuery implements HistoryQuery {

        private final List<Operation> operations;

        ListQuery(List<Operation> operations) {
            this.operations = operations;
        }

        @Override
        public HistoryPage page(HistoryFilter filter, HistoryCursor after, int pageSize) {
            int from = 0;
            if (after instanceof HistoryCursor.After position) {
                while (!operations.get(from).id().equals(position.id())) {
                    from++;
                }
                from++;
            }
            int to = Math.min(operations.size(), from + pageSize);
            List<Operation> slice = operations.subList(from, to);
            HistoryCursor next = to < operations.size() ? new HistoryCursor.After(slice.get(slice.size() - 1).createdAt(), slice.get(slice.size() - 1).id())
                : new HistoryCursor.End();
            return new HistoryPage(slice, next);
        }

        @Override
        public Optional<Operation> publicMetadata(OperationId id) {
            return operations.stream().filter(operation -> operation.id().equals(id)).findFirst();
        }
    }
}
