package io.github.jaeseongs95.portal.server.assembly;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.UUID;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.core.task.TaskExecutor;
import org.springframework.scheduling.TaskScheduler;

import io.github.jaeseongs95.portal.app.agentcli.AgentCliRun;
import io.github.jaeseongs95.portal.app.agentcli.AgentCliService;
import io.github.jaeseongs95.portal.app.agentcli.AgentReleaseCatalog;
import io.github.jaeseongs95.portal.app.agentcli.TarballResult;
import io.github.jaeseongs95.portal.app.cli.AgentCliInstallRecord;
import io.github.jaeseongs95.portal.app.cli.AgentCliRequestStore;
import io.github.jaeseongs95.portal.app.cli.RemoteStatus;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionLimits;
import io.github.jaeseongs95.portal.app.remote.FilePathPolicy;
import io.github.jaeseongs95.portal.app.remote.PathPolicyDecision;
import io.github.jaeseongs95.portal.app.remote.SshSettings;
import io.github.jaeseongs95.portal.app.target.TargetSource;
import io.github.jaeseongs95.portal.domain.approval.ApprovalPolicy;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliAction;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliIntent;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProviderId;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliRequest;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliTargetBinding;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;
import io.github.jaeseongs95.portal.domain.agentcli.CodexCliProvider;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.AgentCliInput;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.RemoteState;
import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import io.github.jaeseongs95.portal.domain.schedule.AdmissionLimits;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;
import io.github.jaeseongs95.portal.domain.target.TargetLookup;
import io.github.jaeseongs95.portal.ssh.session.SessionReapSettings;
import io.github.jaeseongs95.portal.ssh.testkit.EmbeddedSshServer;

/**
 * The default values of {@link AssemblyDefaults} (each one is replaced by the settings binding in stage 4): in the assembled context they are the 2.x defaults, and the
 * defaults that are not a number are the safe ones, that is, they refuse: no target is registered and the path policy cannot be established.
 */
@FullAssemblyTest
class AssemblyDefaultsTest {

    private final ConnectionFiles files;
    private final SshSettings ssh;
    private final SessionReapSettings reap;
    private final ConcurrencyLimits concurrency;
    private final AdmissionLimits admission;
    private final ApprovalPolicy approval;
    private final ExecutionLimits execution;
    private final TaskScheduler scheduler;
    private final TaskExecutor executor;
    private final AgentReleaseCatalog releases;
    private final AgentCliService agentCli;
    private final AgentCliRequestStore store;
    private final OperationJournal journal;
    private final EmbeddedSshServer server;
    private final EmbeddedTargets targets;
    private final Digester digester;
    private final Clock clock;

    AssemblyDefaultsTest(ConnectionFiles files, SshSettings ssh, SessionReapSettings reap, ConcurrencyLimits concurrency, AdmissionLimits admission, ApprovalPolicy approval,
                         ExecutionLimits execution, TaskScheduler scheduler, TaskExecutor executor, AgentReleaseCatalog releases, AgentCliService agentCli,
                         AgentCliRequestStore store, OperationJournal journal, EmbeddedSshServer server, EmbeddedTargets targets, Digester digester, Clock clock) {
        this.releases = releases;
        this.agentCli = agentCli;
        this.store = store;
        this.journal = journal;
        this.server = server;
        this.targets = targets;
        this.digester = digester;
        this.clock = clock;
        this.files = files;
        this.ssh = ssh;
        this.reap = reap;
        this.concurrency = concurrency;
        this.admission = admission;
        this.approval = approval;
        this.execution = execution;
        this.scheduler = scheduler;
        this.executor = executor;
    }

    @Test
    @DisplayName("the numbers of the assembled context are the 2.x defaults, and the known hosts file is the one of the connection files")
    void theNumbersAreTheDefaults() {
        assertThat(ssh).isEqualTo(SshSettings.defaults(files.knownHosts()));
        assertThat(reap).isEqualTo(SessionReapSettings.defaults());
        assertThat(concurrency).isEqualTo(ConcurrencyLimits.defaults());
        assertThat(admission).isEqualTo(AdmissionLimits.defaults());
        assertThat(approval).as("the request capacity 100 of 2.x is inside the policy, which has no equality; it is one bean").isNotNull();
        assertThat(execution).isEqualTo(ExecutionLimits.defaults());
    }

    @Test
    @DisplayName("the timers and the blocking work run on beans of the assembly: a scheduler, and an executor that is not the scheduler (the scheduler is an executor too, so the executor is primary)")
    void theExecutorsAreSeparate() {
        assertThat(scheduler).isNotNull();
        assertThat(executor).isNotSameAs(scheduler);
    }

    @Test
    @DisplayName("without a configuration reader no target is registered and the path policy of a file cannot be established: both refuse, neither allows")
    void theDefaultsThatAreNotNumbersRefuse() {
        AssemblyDefaults defaults = new AssemblyDefaults(new ConnectionFiles(Path.of("profiles.toml"), Path.of("known_hosts")));
        TargetId id = new TargetId("any-target");

        TargetSource targets = defaults.targetSource();
        FilePathPolicy policy = defaults.filePathPolicy();

        assertThat(targets.lookup(id)).isEqualTo(new TargetLookup.NotRegistered(id));
        assertThat(defaults.configuredTargets().entries()).isEmpty();
        assertThat(policy.decide(id, new PosixRemotePath("/srv/file"))).isEqualTo(new PathPolicyDecision.Unconfirmed());
    }

    @Test
    @DisplayName("S3-AG-01: with no release catalog configured (the default until stage 4) an installation is refused at the known point: failed, not dispatched, and not one connection or command reaches the server")
    void anInstallationWithoutACatalogSendsNothing() {
        AgentCliRun run = planOf();
        int connections = server.acceptedConnections().size();
        int commands = server.execRequestCount();

        ExecutionOutcome outcome = agentCli.install(run, new ExecutionControl(new CancelSource(), () -> { }));

        assertThat(releases.fetch(store.findByOperation(run.operation()).orElseThrow().release())).isEqualTo(new TarballResult.Unavailable());
        assertThat(outcome.verdict()).isEqualTo(OperationState.FAILED);
        assertThat(outcome.remoteState()).isEqualTo(RemoteState.NOT_DISPATCHED);
        assertThat(server.acceptedConnections().size()).as("no connection was made").isEqualTo(connections);
        assertThat(server.execRequestCount()).as("no command was sent").isEqualTo(commands);
    }

    /** An accepted operation of kind AGENT_CLI with its install record, as the intake would have stored it, and the run the dispatcher would hand over. */
    private AgentCliRun planOf() {
        CodexCliProvider provider = new CodexCliProvider();
        String integrity = "sha512-" + Base64.getEncoder().encodeToString(new byte[64]);
        AgentRelease release = AgentRelease.verify(provider, "@openai/codex", "1.2.3", "https://registry.npmjs.org/@openai/codex/-/codex-1.2.3.tgz", integrity, digester);
        ResolvedTarget target = targets.target();
        RequestKey key = new RequestKey("agentcli-default-" + UUID.randomUUID());
        Digest expected = new Digest("e".repeat(64));
        AgentCliRequest request = new AgentCliRequest(EmbeddedTargets.ID, target.revision(), EmbeddedTargets.WRITE_PROFILE, AgentCliProviderId.CODEX, AgentCliAction.INSTALL,
            release.releaseDigestLabel(), expected, key);
        Instant now = clock.instant();
        AgentCliIntent intent = AgentCliIntent.of(provider, request, new AgentCliTargetBinding(EmbeddedTargets.ID, target.revision(), EmbeddedTargets.WRITE_PROFILE, true),
            release, now.plus(Duration.ofMinutes(5)).truncatedTo(ChronoUnit.MILLIS), now, digester);
        OperationId id = journal.accept(NewOperation.of(digester, key, new OwnerId("owner"), EmbeddedTargets.ID, target.revision(), EmbeddedTargets.WRITE_PROFILE,
            new AgentCliInput(intent.intentDigest()), new ConflictKey.None(), new Deadline.None())).operation().id();
        store.insert(new AgentCliInstallRecord(id, AgentCliProviderId.CODEX, AgentCliAction.INSTALL, release, expected, "sha256:" + intent.intentDigest().hex(),
            intent.expiresAt(), new RemoteStatus.NotReported()));
        return new AgentCliRun(id, key, target, target.revision(), EmbeddedTargets.WRITE_PROFILE);
    }
}
