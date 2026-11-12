package io.github.jaeseongs95.portal.server.assembly;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import io.github.jaeseongs95.portal.app.artifact.ArtifactPayloadStore;
import io.github.jaeseongs95.portal.app.artifact.ArtifactPinning;
import io.github.jaeseongs95.portal.app.artifact.ArtifactReaper;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRecord;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRegistry;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRetention;
import io.github.jaeseongs95.portal.app.artifact.StagedActionKind;
import io.github.jaeseongs95.portal.app.file.DownloadExecution;
import io.github.jaeseongs95.portal.app.file.DownloadJob;
import io.github.jaeseongs95.portal.app.file.DownloadService;
import io.github.jaeseongs95.portal.app.file.FilePermission;
import io.github.jaeseongs95.portal.app.file.StagedBegin;
import io.github.jaeseongs95.portal.app.file.StagedFileService;
import io.github.jaeseongs95.portal.app.file.StagedPlacement;
import io.github.jaeseongs95.portal.app.file.StagedPlacementRequest;
import io.github.jaeseongs95.portal.app.file.UploadJob;
import io.github.jaeseongs95.portal.app.file.UploadService;
import io.github.jaeseongs95.portal.app.history.ExecutionTimelineStore;
import io.github.jaeseongs95.portal.app.journal.ClaimResult;
import io.github.jaeseongs95.portal.app.journal.ClaimStore;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.app.output.OutputPayloadStore;
import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionPhase;
import io.github.jaeseongs95.portal.app.remote.ExecutionTimeline;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.app.storage.ProtectionCheck;
import io.github.jaeseongs95.portal.app.storage.StorageProtection;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliCatalog;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProvider;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProviderId;
import io.github.jaeseongs95.portal.domain.file.FileBinding;
import io.github.jaeseongs95.portal.domain.file.FileName;
import io.github.jaeseongs95.portal.domain.file.FileTargetBinding;
import io.github.jaeseongs95.portal.domain.id.ArtifactUuid;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.operation.CommandInput;
import io.github.jaeseongs95.portal.domain.operation.CompletionEvidence;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.DownloadInput;
import io.github.jaeseongs95.portal.domain.operation.Elevation;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationEvent;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.operation.StartAuthority;
import io.github.jaeseongs95.portal.domain.operation.UploadInput;
import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import io.github.jaeseongs95.portal.store.StorageRoots;
import io.github.jaeseongs95.portal.store.artifact.ArtifactLimits;
import io.github.jaeseongs95.portal.store.audit.AuditFileLocation;

/**
 * S3-UC-08: the minimal assembly of the server. The store and the use cases are in one context; the four values that the store asks for are made from the settings; the
 * file I/O of the stores happens outside a transaction. Then one upload, one download and one execution run from the start to the end through the real stores, with only the
 * SSH boundary faked (the real adapter of portal-ssh is connected by the merge): the staged file, its copy, the admitted upload, the transfer, the settlement in the journal,
 * the timeline, the release of the pinned artifact; the read of a file into a ready artifact; the settlement of a command.
 */
@AssemblyTest
class AssemblyContextTest {

    private static final Sha256Digester DIGEST = new Sha256Digester();
    private static final OwnerId OWNER = new OwnerId("verified-owner");
    private static final ExecutionControl CONTROL = new ExecutionControl(new CancelSource(), () -> { });

    private final StorageSettings settings;
    private final StorageRoots roots;
    private final ArtifactLimits artifactLimits;
    private final AuditFileLocation audit;
    private final TransferLimits transferLimits;
    private final AgentCliCatalog providers;
    private final StorageProtection protection;
    private final ArtifactPayloadStore artifactPayloads;
    private final OutputPayloadStore outputPayloads;
    private final ArtifactReaper reaper;
    private final StagedFileService staged;
    private final UploadService uploads;
    private final DownloadService downloads;
    private final ArtifactRegistry registry;
    private final ArtifactPinning pinning;
    private final OperationJournal journal;
    private final ClaimStore claims;
    private final ExecutionTimelineStore timelines;
    private final FakeAdmission admission;
    private final FakeRemote remote;
    private final FakeTargets targets;
    private final Digester digester;
    private final JdbcTemplate jdbc;
    private final Clock clock;

    AssemblyContextTest(StorageSettings settings, StorageRoots roots, ArtifactLimits artifactLimits, AuditFileLocation audit, TransferLimits transferLimits,
                        AgentCliCatalog providers, StorageProtection protection, ArtifactPayloadStore artifactPayloads, OutputPayloadStore outputPayloads, ArtifactReaper reaper,
                        StagedFileService staged, UploadService uploads, DownloadService downloads, ArtifactRegistry registry, ArtifactPinning pinning, OperationJournal journal,
                        ClaimStore claims, ExecutionTimelineStore timelines, FakeAdmission admission, FakeRemote remote, FakeTargets targets, Digester digester,
                        JdbcTemplate jdbc, Clock clock) {
        this.settings = settings;
        this.roots = roots;
        this.artifactLimits = artifactLimits;
        this.audit = audit;
        this.transferLimits = transferLimits;
        this.providers = providers;
        this.protection = protection;
        this.artifactPayloads = artifactPayloads;
        this.outputPayloads = outputPayloads;
        this.reaper = reaper;
        this.staged = staged;
        this.uploads = uploads;
        this.downloads = downloads;
        this.registry = registry;
        this.pinning = pinning;
        this.journal = journal;
        this.claims = claims;
        this.timelines = timelines;
        this.admission = admission;
        this.remote = remote;
        this.targets = targets;
        this.digester = digester;
        this.jdbc = jdbc;
        this.clock = clock;
    }

    @BeforeEach
    void clean() {
        remote.reset();
        admission.reset();
        targets.reset();
        jdbc.update("DELETE FROM staged_action");
        jdbc.update("DELETE FROM artifact_chunk");
        jdbc.update("DELETE FROM artifact");
    }

    @Test
    @DisplayName("S3-UC-08: StorageRoots, ArtifactLimits and AuditFileLocation are made from the settings, the transfer limit is the artifact limit, both providers are in the catalog, and the folders are protected")
    void theValueBeansAreMadeFromTheSettings() {
        assertThat(roots.artifacts()).isEqualTo(settings.artifactsFolder());
        assertThat(roots.outputs()).isEqualTo(settings.outputsFolder());
        assertThat(artifactLimits).isSameAs(settings.artifactLimits());
        assertThat(audit.file()).isEqualTo(settings.auditFile());
        assertThat(transferLimits.maxFileSize().toBytes()).isEqualTo(artifactLimits.maxFileBytes());
        assertThat(providers.providers()).extracting(AgentCliProvider::id).containsExactlyInAnyOrder(AgentCliProviderId.CODEX, AgentCliProviderId.CLAUDE);
        assertThat(protection.check()).isEqualTo(new ProtectionCheck.Protected());
    }

    @Test
    @DisplayName("S3-UC-08 / design 4.4: the file I/O of the stores (usable space of both stores) is done outside a transaction, and the reaper of the artifacts runs on the real store")
    void theFileIoIsOutsideATransaction() {
        assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();

        assertThat(artifactPayloads.usable().usableBytes()).isPositive();
        assertThat(outputPayloads.usable().usableBytes()).isPositive();
        assertThat(reaper.reap()).isNotNull();
    }

    @Test
    @DisplayName("S3-UC-08: one upload runs from the staged file to the settled operation: stage, copy, admit, transfer, settle in the journal as COMPLETED, record the timeline, unpin the copy")
    void anUploadRunsFromTheStagedFileToTheSettledOperation() {
        byte[] bytes = new byte[3000];
        Arrays.fill(bytes, (byte) 8);
        ArtifactUuid uuid = ((StagedBegin.Begun) staged.begin(OWNER, "assembly-upload-key-1", new FileName("report.bin"), bytes.length)).uuid();
        staged.append(OWNER, uuid, 0, bytes, DIGEST.digest(bytes));
        staged.complete(OWNER, uuid);
        ResolvedTarget linux = targets.linux();

        StagedPlacement placement = staged.place(new StagedPlacementRequest(OWNER, uuid, StagedActionKind.COPY, "assembly-upload-op-1", linux, linux.revision(),
            new PosixRemotePath("/srv/report.bin"), OverwriteMode.REPLACE, Elevation.NONE));

        assertThat(placement).isInstanceOf(StagedPlacement.Placed.class);
        NewOperation admitted = admission.admitted.get(0);
        UploadInput input = (UploadInput) admitted.input();
        ExecutionOutcome outcome = uploads.upload(new UploadJob(linux, linux.revision(), input, new FilePermission.PlatformDefault()), CONTROL);
        assertThat(outcome.evidence()).isInstanceOf(CompletionEvidence.FilePublished.class);
        assertThat(remote.uploaded).isEqualTo(bytes);

        Operation running = claimAndRun(admitted);
        Operation settled = journal.save(running.settle(outcome, clock.instant()), running.version());
        timelines.record(settled.id(), ExecutionTimeline.empty().marked(ExecutionPhase.CONNECTED, clock.instant()).marked(ExecutionPhase.REQUEST_SENT, clock.instant())
            .marked(ExecutionPhase.CLOSED, clock.instant()));
        pinning.operationSettled(input.artifactId(), settled.state());

        assertThat(settled.state()).isEqualTo(OperationState.COMPLETED);
        assertThat(journal.find(settled.id()).orElseThrow().state()).isEqualTo(OperationState.COMPLETED);
        assertThat(timelines.timelineOf(settled.id()).marks()).hasSize(3);
        assertThat(registry.find(input.artifactId()).orElseThrow().spec().retention()).as("the copy is released after its operation settled").isEqualTo(ArtifactRetention.RELEASABLE);
        assertThat(staged.stat(OWNER, uuid).artifact().state()).as("a copy keeps the staged file").isNotNull();
    }

    @Test
    @DisplayName("S3-UC-08: one download runs to a verified, ready artifact whose digest and size are the bytes the target served")
    void aDownloadRunsToAReadyArtifact() {
        remote.served = new byte[850];
        Arrays.fill(remote.served, (byte) 5);
        ResolvedTarget linux = targets.linux();

        DownloadExecution execution = downloads.download(new DownloadJob(linux, linux.revision(), new DownloadInput(new PosixRemotePath("/var/log/app.log"), Elevation.NONE,
            new FileBinding.Bound(new FileTargetBinding(FakeTargets.LINUX_ID, linux.revision())), new Utf8Text("caller"), new Utf8Text("display"))), CONTROL);

        assertThat(execution).isInstanceOf(DownloadExecution.Stored.class);
        ArtifactRecord artifact = ((DownloadExecution.Stored) execution).artifact();
        assertThat(artifact.spec().sizeBytes()).isEqualTo(850);
        assertThat(execution.outcome().verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(registry.find(artifact.id()).orElseThrow()).isEqualTo(artifact);
    }

    @Test
    @DisplayName("S3-UC-08: one execution runs once through the journal: accepted, approved, claimed, running, settled as COMPLETED with the exit as evidence, and its timeline is stored")
    void anExecutionIsSettledOnceThroughTheJournal() {
        RequestKey key = new RequestKey("assembly-command-key-00001");
        ResolvedTarget linux = targets.linux();
        NewOperation spec = NewOperation.of(digester, key, OWNER, FakeTargets.LINUX_ID, linux.revision(), FakeTargets.LINUX_WRITE,
            new CommandInput(new CommandText("echo ok"), new Utf8Text("caller"), new Utf8Text("display")), new ConflictKey.None(), new Deadline.None());

        Operation running = claimAndRun(spec);
        Operation settled = journal.save(running.settle(ExecutionOutcome.exited(0, List.of("ok")), clock.instant()), running.version());
        Instant at = clock.instant();
        timelines.record(settled.id(), ExecutionTimeline.empty().marked(ExecutionPhase.CONNECTED, at));

        assertThat(settled.state()).isEqualTo(OperationState.COMPLETED);
        assertThat(timelines.timelineOf(settled.id()).at(ExecutionPhase.CONNECTED)).isPresent();
        assertThat(journal.events(settled.id())).extracting(OperationEvent::state).endsWith(OperationState.RUNNING, OperationState.COMPLETED);
    }

    /** Accepts the operation, has the owner approve it, claims it and marks it running: the steps of the dispatcher that the journal records. */
    private Operation claimAndRun(NewOperation spec) {
        Operation accepted = journal.accept(spec).operation();
        Operation pending = journal.save(accepted.awaitOwnerDecision(clock.instant()), accepted.version());
        Operation queued = journal.save(pending.enqueue(new StartAuthority.Owner(), clock.instant()), pending.version());
        ClaimResult claimed = claims.claim(queued.id(), queued.version(), ConcurrencyLimits.defaults(), clock.instant());
        assertThat(claimed).isInstanceOf(ClaimResult.Claimed.class);
        Operation starting = ((ClaimResult.Claimed) claimed).operation();
        return journal.save(starting.markRunning(clock.instant()), starting.version());
    }
}
