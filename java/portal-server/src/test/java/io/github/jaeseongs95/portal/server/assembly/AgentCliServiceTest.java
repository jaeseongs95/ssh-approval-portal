package io.github.jaeseongs95.portal.server.assembly;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.app.agentcli.AgentCliRun;
import io.github.jaeseongs95.portal.app.agentcli.AgentCliService;
import io.github.jaeseongs95.portal.app.cli.AgentCliInstallRecord;
import io.github.jaeseongs95.portal.app.cli.AgentCliRequestStore;
import io.github.jaeseongs95.portal.app.cli.CliVersion;
import io.github.jaeseongs95.portal.app.cli.RemoteStatus;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.app.remote.AgentCliInstallResult;
import io.github.jaeseongs95.portal.app.remote.AgentCliRefusal;
import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.RestoreEvidence;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.app.remote.UnconfirmedCause;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliAction;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliIntent;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProviderId;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliRequest;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliTargetBinding;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;
import io.github.jaeseongs95.portal.domain.agentcli.CodexCliProvider;
import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchRefusedException;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.operation.AgentCliInput;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.operation.CompletionEvidence;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.RemoteState;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;

/**
 * The installation of an agent CLI on the real stores with the registry and the installer faked (S3-AG, G10 and defect D-0035). The order is the contract: the plan, the
 * expiry, the target binding and the intent digest are checked first and a failure there fetches and sends nothing; then the catalog; then the installer; then the journal.
 * {@code cleanupFailures} of 0 is "nothing failed to clean up" (S3-AG-08; no test of this version still refused a 0: RC-A-047 of the store already stores it as none).
 */
@AssemblyTest
class AgentCliServiceTest {

    private static final ExecutionControl CONTROL = new ExecutionControl(new CancelSource(), () -> { });
    private static final AtomicInteger KEYS = new AtomicInteger();
    private static final io.github.jaeseongs95.portal.app.cli.RemoteState COMPLETED = io.github.jaeseongs95.portal.app.cli.RemoteState.COMPLETED;

    private final AgentCliService service;
    private final FakeCatalog catalog;
    private final FakeInstaller installer;
    private final FakeTargets targets;
    private final OperationJournal journal;
    private final AgentCliRequestStore store;
    private final Digester digester;
    private final Clock clock;

    AgentCliServiceTest(AgentCliService service, FakeCatalog catalog, FakeInstaller installer, FakeTargets targets, OperationJournal journal, AgentCliRequestStore store,
                        Digester digester, Clock clock) {
        this.service = service;
        this.catalog = catalog;
        this.installer = installer;
        this.targets = targets;
        this.journal = journal;
        this.store = store;
        this.digester = digester;
        this.clock = clock;
    }

    @BeforeEach
    void reset() {
        catalog.reset();
        installer.reset();
        targets.reset();
    }

    @Test
    @DisplayName("S3-AG-01 / G10: the plan and the intent are verified, then the catalog is asked, then the installer, and the journal records what the target reported; Installed completes with its evidence")
    void anInstallationFollowsTheFixedOrder() {
        Plan plan = plan(Duration.ofMinutes(5), null, null, null);

        ExecutionOutcome outcome = service.install(plan.run(), CONTROL);

        assertThat(catalog.log).containsExactly("catalog.fetch", "installer.install");
        assertThat(outcome.verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(outcome.evidence()).isInstanceOfSatisfying(CompletionEvidence.FilePublished.class,
            evidence -> assertThat(evidence.sha256()).isEqualTo(plan.release().releaseDigest()));
        assertThat(remoteOf(plan)).isEqualTo(new RemoteStatus.Known(COMPLETED, new CliVersion("1.2.3"), 0));
    }

    @Test
    @DisplayName("S3-AG-08: a cleanup count of 0 is none and a positive count is kept as it is, for a completed and for a failed installation")
    void aCleanupCountOfZeroIsNone() {
        Plan zero = plan(Duration.ofMinutes(5), null, null, null);
        service.install(zero.run(), CONTROL);
        assertThat(remoteOf(zero)).isEqualTo(new RemoteStatus.Known(COMPLETED, new CliVersion("1.2.3"), 0));

        Plan two = plan(Duration.ofMinutes(5), null, null, null);
        installer.answer = new AgentCliInstallResult.Installed(new CliVersion("1.2.3"), 2, clock.instant());
        service.install(two.run(), CONTROL);
        assertThat(remoteOf(two)).isEqualTo(new RemoteStatus.Known(COMPLETED, new CliVersion("1.2.3"), 2));

        Plan failed = plan(Duration.ofMinutes(5), null, null, null);
        installer.answer = new AgentCliInstallResult.RolledBack(AgentCliRefusal.INSTALL_COMMAND_FAILED, new RestoreEvidence(clock.instant()), 1);
        service.install(failed.run(), CONTROL);
        assertThat(remoteOf(failed)).isEqualTo(new RemoteStatus.Failed(new CliVersion("1.2.3"), 1));
    }

    @Test
    @DisplayName("S3-AG-03 / S3-AG-05 / D-0035: a failure after the switch with the old version back is FAILED, a result that is not known is UNKNOWN, a refusal and a connection that never started are FAILED; none carries evidence, and the same version is a completion")
    void onlyAConfirmedSwitchCompletes() {
        List<InstallCase> cases = List.of(
            new InstallCase(new AgentCliInstallResult.RolledBack(AgentCliRefusal.INSTALL_COMMAND_FAILED, new RestoreEvidence(clock.instant()), 0), OperationState.FAILED),
            new InstallCase(new AgentCliInstallResult.Unconfirmed(new UnconfirmedCause.TransportLost(), 0), OperationState.UNKNOWN),
            new InstallCase(new AgentCliInstallResult.Refused(AgentCliRefusal.PREREQUISITE_MISSING), OperationState.FAILED),
            new InstallCase(new AgentCliInstallResult.NotDispatched(TransferFailureCause.CONNECT_FAILED), OperationState.FAILED));

        for (InstallCase c : cases) {
            Plan plan = plan(Duration.ofMinutes(5), null, null, null);
            installer.answer = c.answer();

            ExecutionOutcome outcome = service.install(plan.run(), CONTROL);

            assertThat(outcome.verdict()).as(c.answer().toString()).isEqualTo(c.state());
            assertThat(outcome.evidence()).isInstanceOf(CompletionEvidence.NoEvidence.class);
        }
        Plan reused = plan(Duration.ofMinutes(5), null, null, null);
        installer.answer = new AgentCliInstallResult.Reused(new CliVersion("1.2.3"));
        assertThat(service.install(reused.run(), CONTROL).verdict()).as("S3-AG-03: the same version is already there").isEqualTo(OperationState.COMPLETED);
        assertThat(remoteOf(reused)).isEqualTo(new RemoteStatus.Known(io.github.jaeseongs95.portal.app.cli.RemoteState.REUSED, new CliVersion("1.2.3"), 0));

        Plan neverSent = plan(Duration.ofMinutes(5), null, null, null);
        installer.answer = new AgentCliInstallResult.NotDispatched(TransferFailureCause.CONNECT_FAILED);
        service.install(neverSent.run(), CONTROL);
        assertThat(remoteOf(neverSent)).as("an installation that never reached the target records nothing").isEqualTo(new RemoteStatus.NotReported());
    }

    @Test
    @DisplayName("S3-AG-02 / G10: a plan that does not hold is refused before anything is fetched or sent: a changed release, an expired plan, another intent digest, a target that changed")
    void aPlanThatDoesNotHoldFetchesAndSendsNothing() {
        Plan base = plan(Duration.ofMinutes(5), null, null, null);
        AgentRelease altered = new AgentRelease(base.release().provider(), base.release().packageName(), base.release().version(), base.release().tarball(),
            base.release().integrity(), new Digest("f".repeat(64)));
        Plan changedRelease = plan(Duration.ofMinutes(5), altered, null, null);
        Plan expired = plan(Duration.ofMinutes(5), null, null, clock.instant().minusSeconds(60));
        Plan otherDigest = plan(Duration.ofMinutes(5), null, "sha256:" + "0".repeat(64), null);
        Plan stale = plan(Duration.ofMinutes(5), null, null, null);
        targets.changeLinux("Web one, changed");

        check(changedRelease.run(), DispatchReason.PRIVATE_PLAN, DispatchStage.CLI_GUARD);
        check(expired.run(), DispatchReason.PLAN_EXPIRED, DispatchStage.CLI_GUARD);
        check(otherDigest.run(), DispatchReason.PRIVATE_PLAN, DispatchStage.CLI_GUARD);
        AgentCliRun onTheChangedTarget = new AgentCliRun(stale.run().operation(), stale.run().requestKey(), targets.linux(), stale.run().approvedRevision(),
            stale.run().approvedProfile());
        check(onTheChangedTarget, DispatchReason.TARGET_CHANGED, DispatchStage.TARGET_GUARD);
        assertThat(catalog.log).as("nothing was fetched").isEmpty();
    }

    @Test
    @DisplayName("S3-AG-01: a package that the catalog cannot give is a failure with the target untouched; the installer is never called")
    void anUnavailablePackageFailsBeforeTheInstaller() {
        Plan plan = plan(Duration.ofMinutes(5), null, null, null);
        catalog.available = false;

        ExecutionOutcome outcome = service.install(plan.run(), CONTROL);

        assertThat(catalog.log).containsExactly("catalog.fetch");
        assertThat(outcome.verdict()).isEqualTo(OperationState.FAILED);
        assertThat(outcome.remoteState()).isEqualTo(RemoteState.NOT_DISPATCHED);
        assertThat(outcome.cleanup()).isEqualTo(CleanupState.COMPLETE);
    }

    // ---- helpers ----

    private record InstallCase(AgentCliInstallResult answer, OperationState state) {
    }

    private record Plan(AgentCliRun run, AgentRelease release) {
    }

    private void check(AgentCliRun run, DispatchReason reason, DispatchStage stage) {
        assertThatThrownBy(() -> service.install(run, CONTROL)).isInstanceOfSatisfying(DispatchRefusedException.class,
            e -> assertThat(e.failure()).isEqualTo(DispatchFailure.refused(reason, stage)));
    }

    private RemoteStatus remoteOf(Plan plan) {
        return store.findByOperation(plan.run().operation()).orElseThrow().remote();
    }

    /**
     * An accepted operation of kind AGENT_CLI with its install record, as the intake would have stored it, and the run the dispatcher would hand over. A {@code null}
     * argument is "as the intake made it"; a value replaces the stored release, intent digest or expiry, which is how a stored plan that was changed looks to the service.
     */
    private Plan plan(Duration validFor, AgentRelease storedRelease, String storedIntentDigest, Instant storedExpiry) {
        CodexCliProvider provider = new CodexCliProvider();
        String integrity = "sha512-" + Base64.getEncoder().encodeToString(new byte[64]);
        AgentRelease release = AgentRelease.verify(provider, "@openai/codex", "1.2.3", "https://registry.npmjs.org/@openai/codex/-/codex-1.2.3.tgz", integrity, digester);
        ResolvedTarget target = targets.linux();
        RequestKey key = new RequestKey("agentcli-request-" + KEYS.incrementAndGet() + "-0000000000");
        Digest expected = new Digest("e".repeat(64));
        AgentCliRequest request = new AgentCliRequest(FakeTargets.LINUX_ID, target.revision(), FakeTargets.LINUX_WRITE, AgentCliProviderId.CODEX, AgentCliAction.INSTALL,
            release.releaseDigestLabel(), expected, key);
        Instant now = clock.instant();
        AgentCliIntent intent = AgentCliIntent.of(provider, request, new AgentCliTargetBinding(FakeTargets.LINUX_ID, target.revision(), FakeTargets.LINUX_WRITE, true), release,
            now.plus(validFor).truncatedTo(ChronoUnit.MILLIS), now, digester);
        OperationId id = journal.accept(NewOperation.of(digester, key, new OwnerId("owner"), FakeTargets.LINUX_ID, target.revision(), FakeTargets.LINUX_WRITE,
            new AgentCliInput(intent.intentDigest()), new ConflictKey.None(), new Deadline.None())).operation().id();
        store.insert(new AgentCliInstallRecord(id, AgentCliProviderId.CODEX, AgentCliAction.INSTALL, storedRelease == null ? release : storedRelease, expected,
            storedIntentDigest == null ? "sha256:" + intent.intentDigest().hex() : storedIntentDigest, storedExpiry == null ? intent.expiresAt() : storedExpiry,
            new RemoteStatus.NotReported()));
        return new Plan(new AgentCliRun(id, key, target, target.revision(), FakeTargets.LINUX_WRITE), release);
    }
}
