package io.github.jaeseongs95.portal.server.assembly;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Clock;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import io.github.jaeseongs95.portal.app.capacity.CapacityService;
import io.github.jaeseongs95.portal.app.capacity.CapacityState;
import io.github.jaeseongs95.portal.app.config.AvailableCpus;
import io.github.jaeseongs95.portal.app.journal.ClaimResult;
import io.github.jaeseongs95.portal.app.journal.ClaimStore;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.app.maintenance.MaintenanceStore;
import io.github.jaeseongs95.portal.app.maintenance.OwnerHash;
import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.error.CapacityErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.CommandInput;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.StartAuthority;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;
import io.github.jaeseongs95.portal.domain.target.CapacityOverride;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;

/**
 * The runtime capacity override on the real stores (RC-B-410 and its neighbours): the first read stores the installation defaults, a change is one compare-and-set under the
 * revision the administrator saw, and no refusal changes the stored value. Lowering the limits below the work that runs or waits leaves that work as it is.
 */
@AssemblyTest
class CapacityServiceTest {

    private static final AtomicInteger KEYS = new AtomicInteger();
    private static final OwnerHash OWNER = new OwnerHash("c".repeat(64));

    private final CapacityService service;
    private final OperationJournal journal;
    private final ClaimStore claims;
    private final MaintenanceStore maintenance;
    private final AvailableCpus cpus;
    private final Digester digester;
    private final JdbcTemplate jdbc;
    private final Clock clock;

    CapacityServiceTest(CapacityService service, OperationJournal journal, ClaimStore claims, MaintenanceStore maintenance, AvailableCpus cpus, Digester digester,
                        JdbcTemplate jdbc, Clock clock) {
        this.service = service;
        this.journal = journal;
        this.claims = claims;
        this.maintenance = maintenance;
        this.cpus = cpus;
        this.digester = digester;
        this.jdbc = jdbc;
        this.clock = clock;
    }

    @BeforeEach
    void clean() {
        jdbc.update("DELETE FROM runtime_capacity_target");
        jdbc.update("DELETE FROM runtime_capacity");
        jdbc.update("DELETE FROM maintenance_release");
        jdbc.update("DELETE FROM maintenance_reservation");
    }

    @Test
    @DisplayName("S3-UC-08 / RC-B-410: the first read stores the installation defaults (ten queued requests and one operation per CPU, and the limits of each configured target) and a second read answers the same revision")
    void theFirstReadStoresTheDefaults() {
        CapacityState state = service.current();

        assertThat(state.queueCapacity()).isEqualTo(new Capacity(cpus.count() * 10));
        assertThat(state.maxConcurrency()).isEqualTo(new Capacity(cpus.count()));
        assertThat(state.targets()).extracting(CapacityState.TargetCapacity::targetId).containsExactlyInAnyOrder(FakeTargets.LINUX_ID, FakeTargets.WINDOWS_ID);
        assertThat(service.current()).isEqualTo(state);
    }

    @Test
    @DisplayName("RC-B-410: lowering the limits to 1 and 1 while one operation runs and one waits changes no operation and stores a new revision")
    void loweringTheLimitsLeavesTheWorkAlone() {
        Operation running = running();
        Operation queued = queued();
        CapacityState stored = service.current();

        CapacityState next = service.update(stored.revision(), new CapacityState(stored.revision(), new Capacity(1), new Capacity(1), stored.targets()));

        assertThat(next.revision()).isNotEqualTo(stored.revision());
        assertThat(next.queueCapacity()).isEqualTo(new Capacity(1));
        assertThat(next.maxConcurrency()).isEqualTo(new Capacity(1));
        assertThat(service.current()).isEqualTo(next);
        assertThat(journal.find(running.id()).orElseThrow().state()).isEqualTo(OperationState.RUNNING);
        assertThat(journal.find(queued.id()).orElseThrow().state()).isEqualTo(OperationState.QUEUED);
    }

    @Test
    @DisplayName("RC-B-410: a stale revision, a target that appears twice and a target that is not configured are refused with their own codes, and the stored value is not changed by any of them")
    void aRefusedChangeLeavesTheStoredValueAlone() {
        CapacityState stored = service.current();
        TargetId unknown = new TargetId("not-configured");
        CapacityState.TargetCapacity own = new CapacityState.TargetCapacity(FakeTargets.LINUX_ID, new CapacityOverride.Inherited(), new CapacityOverride.Inherited());

        assertRefused(() -> service.update("0".repeat(32), stored), CapacityErrorCode.CAPACITY_REVISION_CONFLICT);
        assertRefused(() -> service.update(stored.revision(), new CapacityState(stored.revision(), new Capacity(1), new Capacity(1), List.of(own, own))),
            CapacityErrorCode.INVALID_CAPACITY_TARGETS);
        assertRefused(() -> service.update(stored.revision(), new CapacityState(stored.revision(), new Capacity(1), new Capacity(1), List.of(
            new CapacityState.TargetCapacity(unknown, new CapacityOverride.Inherited(), new CapacityOverride.Inherited())))), CapacityErrorCode.UNKNOWN_CAPACITY_TARGET);

        assertThat(service.current()).isEqualTo(stored);
    }

    @Test
    @DisplayName("RC-B-410: while a maintenance reservation holds the installation the limits cannot be changed (MAINTENANCE_ACTIVE) and the stored value stays; after the release the change goes through")
    void maintenanceRefusesAChange() {
        CapacityState stored = service.current();
        maintenance.reserve(OWNER);
        try {
            assertRefused(() -> service.update(stored.revision(), new CapacityState(stored.revision(), new Capacity(1), new Capacity(1), stored.targets())),
                RequestErrorCode.MAINTENANCE_ACTIVE);
            assertThat(service.current()).isEqualTo(stored);
        } finally {
            maintenance.release(OWNER);
        }

        CapacityState next = service.update(stored.revision(), new CapacityState(stored.revision(), new Capacity(1), new Capacity(1), stored.targets()));
        assertThat(next.revision()).isNotEqualTo(stored.revision());
    }

    // ---- helpers ----

    private void assertRefused(Runnable call, io.github.jaeseongs95.portal.domain.error.ErrorCode code) {
        assertThatThrownBy(call::run).isInstanceOfSatisfying(RequestRefusedException.class, e -> assertThat(e.code()).isEqualTo(code));
    }

    private Operation queued() {
        RequestKey key = new RequestKey(String.format("capacity-request-%010d", KEYS.incrementAndGet()));
        NewOperation spec = NewOperation.of(digester, key, new OwnerId("owner"), FakeTargets.WINDOWS_ID, new FakeTargets(digester).windows().revision(),
            FakeTargets.LINUX_WRITE, new CommandInput(new CommandText("echo capacity"), new Utf8Text("caller"), new Utf8Text("display")), new ConflictKey.None(), new Deadline.None());
        Operation accepted = journal.accept(spec).operation();
        Operation pending = journal.save(accepted.awaitOwnerDecision(clock.instant()), accepted.version());
        return journal.save(pending.enqueue(new StartAuthority.Owner(), clock.instant()), pending.version());
    }

    private Operation running() {
        Operation queued = queued();
        ClaimResult claimed = claims.claim(queued.id(), queued.version(), ConcurrencyLimits.defaults(), clock.instant());
        assertThat(claimed).isInstanceOf(ClaimResult.Claimed.class);
        Operation starting = ((ClaimResult.Claimed) claimed).operation();
        return journal.save(starting.markRunning(clock.instant()), starting.version());
    }
}
