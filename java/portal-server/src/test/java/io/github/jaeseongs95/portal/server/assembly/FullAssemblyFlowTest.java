package io.github.jaeseongs95.portal.server.assembly;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.io.IOException;
import java.nio.channels.Channels;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Arrays;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.app.artifact.ArtifactRecord;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRegistry;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRetention;
import io.github.jaeseongs95.portal.app.artifact.ArtifactState;
import io.github.jaeseongs95.portal.app.artifact.StagedAction;
import io.github.jaeseongs95.portal.app.artifact.StagedActionKind;
import io.github.jaeseongs95.portal.app.artifact.StagedActionState;
import io.github.jaeseongs95.portal.app.file.DownloadExecution;
import io.github.jaeseongs95.portal.app.file.DownloadJob;
import io.github.jaeseongs95.portal.app.file.DownloadService;
import io.github.jaeseongs95.portal.app.file.StagedBegin;
import io.github.jaeseongs95.portal.app.file.StagedFileService;
import io.github.jaeseongs95.portal.app.file.StagedPlacement;
import io.github.jaeseongs95.portal.app.file.StagedPlacementRequest;
import io.github.jaeseongs95.portal.app.history.ExecutionTimelineStore;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.app.operation.OperationIntake;
import io.github.jaeseongs95.portal.app.output.FormatSpan;
import io.github.jaeseongs95.portal.app.output.OutputFormat;
import io.github.jaeseongs95.portal.app.output.OutputManifest;
import io.github.jaeseongs95.portal.app.output.OutputManifestStore;
import io.github.jaeseongs95.portal.app.output.OutputPayloadStore;
import io.github.jaeseongs95.portal.app.output.OutputState;
import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionPhase;
import io.github.jaeseongs95.portal.app.remote.PhaseMark;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.domain.file.FileBinding;
import io.github.jaeseongs95.portal.domain.file.FileName;
import io.github.jaeseongs95.portal.domain.file.FileTargetBinding;
import io.github.jaeseongs95.portal.domain.id.ArtifactUuid;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.operation.CommandInput;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.DownloadInput;
import io.github.jaeseongs95.portal.domain.operation.Elevation;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.operation.StartAuthority;
import io.github.jaeseongs95.portal.domain.operation.UploadInput;
import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import io.github.jaeseongs95.portal.ssh.testkit.EmbeddedSshServer;

/**
 * The completion condition of the assembly: an operation that is submitted in the assembled context is dispatched by the real {@code ExecutionDispatcher}, runs through the
 * real SSH adapter against a real SSH server in this JVM, and ends as the journal, the output store and the timeline store say. Nothing is faked on the way: the stores are the
 * real adapters over the embedded H2 database and real files, the connection is a real MINA connection with the password and the pinned host key of the profile file, and the
 * file transfers use the real SFTP subsystem of the server. The values of the assembly (limits, executors) are the defaults of {@link AssemblyDefaults}.
 */
@FullAssemblyTest
class FullAssemblyFlowTest {

    private static final Sha256Digester DIGEST = new Sha256Digester();
    private static final OwnerId OWNER = new OwnerId("verified-owner");
    private static final StartAuthority APPROVED_BY_OWNER = new StartAuthority.Owner();
    private static final Duration LIMIT = Duration.ofSeconds(30);

    private final OperationIntake intake;
    private final OperationJournal journal;
    private final ExecutionTimelineStore timelines;
    private final OutputManifestStore manifests;
    private final OutputPayloadStore payloads;
    private final StagedFileService staged;
    private final DownloadService downloads;
    private final ArtifactRegistry registry;
    private final EmbeddedSshServer server;
    private final EmbeddedTargets targets;
    private final Digester digester;

    FullAssemblyFlowTest(OperationIntake intake, OperationJournal journal, ExecutionTimelineStore timelines, OutputManifestStore manifests, OutputPayloadStore payloads,
                         StagedFileService staged, DownloadService downloads, ArtifactRegistry registry, EmbeddedSshServer server, EmbeddedTargets targets, Digester digester) {
        this.intake = intake;
        this.journal = journal;
        this.timelines = timelines;
        this.manifests = manifests;
        this.payloads = payloads;
        this.staged = staged;
        this.downloads = downloads;
        this.registry = registry;
        this.server = server;
        this.targets = targets;
        this.digester = digester;
    }

    @Test
    @DisplayName("S3-UC-08: a command that is submitted and approved is dispatched, runs on the SSH server, completes, its output is stored and its timeline is stored")
    void aCommandIsSubmittedDispatchedAndCompleted() throws Exception {
        Operation submitted = intake.submit(command(FullAssemblyApplication.COMMAND));
        assertThat(submitted.state()).isEqualTo(OperationState.PENDING);

        intake.approve(submitted.id(), APPROVED_BY_OWNER);
        Operation done = awaitTerminal(submitted.id());

        assertThat(done.state()).isEqualTo(OperationState.COMPLETED);
        assertThat(server.execRequests().snapshot()).as("the command line reached the server once").containsOnlyOnce(FullAssemblyApplication.COMMAND);
        await().atMost(LIMIT).untilAsserted(() -> assertThat(outputOf(submitted.id())).isEqualTo(FullAssemblyApplication.COMMAND_OUTPUT));
        await().atMost(LIMIT).untilAsserted(() -> assertThat(timelines.timelineOf(submitted.id()).marks().stream().map(PhaseMark::phase).toList())
            .contains(ExecutionPhase.CONNECTED, ExecutionPhase.REQUEST_SENT, ExecutionPhase.CLOSED));
    }

    @Test
    @DisplayName("S3-UC-08: a command that the server does not know exits with 127 and the operation is FAILED, not completed")
    void aCommandThatExitsWithAFailureIsFailed() throws Exception {
        Operation submitted = intake.submit(command("portal-unknown-command"));
        intake.approve(submitted.id(), APPROVED_BY_OWNER);

        Operation done = awaitTerminal(submitted.id());

        assertThat(done.state()).isEqualTo(OperationState.FAILED);
        assertThat(server.execRequests().snapshot()).containsOnlyOnce("portal-unknown-command");
    }

    @Test
    @DisplayName("S3-UC-08: an upload runs from the staged file to the SFTP root of the server: the file is published byte for byte, and the copy of the staged file is released when the operation ends")
    void anUploadIsPublishedThroughSftp() throws Exception {
        byte[] bytes = new byte[3000];
        Arrays.fill(bytes, (byte) 8);
        ArtifactUuid uuid = ((StagedBegin.Begun) staged.begin(OWNER, newKey().value(), new FileName("report.bin"), bytes.length)).uuid();
        staged.append(OWNER, uuid, 0, bytes, DIGEST.digest(bytes));
        staged.complete(OWNER, uuid);
        ResolvedTarget target = targets.target();

        StagedPlacement placement = staged.place(new StagedPlacementRequest(OWNER, uuid, StagedActionKind.COPY, newKey().value(), target, target.revision(),
            new PosixRemotePath("/report.bin"), OverwriteMode.REPLACE, Elevation.NONE));

        assertThat(placement).isInstanceOf(StagedPlacement.Placed.class);
        OperationId id = ((StagedPlacement.Placed) placement).operation();
        intake.approve(id, APPROVED_BY_OWNER);
        Operation done = awaitTerminal(id);

        assertThat(done.state()).isEqualTo(OperationState.COMPLETED);
        assertThat(Files.readAllBytes(sftpRoot().resolve("report.bin"))).isEqualTo(bytes);
        UploadInput input = (UploadInput) done.input();
        await().atMost(LIMIT).untilAsserted(() -> assertThat(registry.find(input.artifactId()).orElseThrow().spec().retention())
            .as("the copy is released after its operation ended").isEqualTo(ArtifactRetention.RELEASABLE));
    }

    @Test
    @DisplayName("RC-B-130 RC-B-132: a move that completes with the publication of this content consumes the staged file and settles its action")
    void aCompletedMoveConsumesTheStagedFile() throws Exception {
        byte[] bytes = new byte[2000];
        Arrays.fill(bytes, (byte) 3);
        ArtifactUuid uuid = stage(bytes);
        ResolvedTarget target = targets.target();

        OperationId id = placed(staged.place(new StagedPlacementRequest(OWNER, uuid, StagedActionKind.MOVE, newKey().value(), target, target.revision(),
            new PosixRemotePath("/moved.bin"), OverwriteMode.REPLACE, Elevation.NONE)));
        intake.approve(id, APPROVED_BY_OWNER);

        assertThat(awaitTerminal(id).state()).isEqualTo(OperationState.COMPLETED);
        assertThat(Files.readAllBytes(sftpRoot().resolve("moved.bin"))).isEqualTo(bytes);
        ArtifactRecord source = registry.findStaged(uuid).orElseThrow();
        await().atMost(LIMIT).untilAsserted(() -> {
            assertThat(registry.find(source.id()).orElseThrow().state()).as("the moved staged file is consumed").isEqualTo(ArtifactState.CONSUMED);
            assertThat(registry.actions(source.id())).extracting(StagedAction::state).containsExactly(StagedActionState.SETTLED);
        });
    }

    @Test
    @DisplayName("RC-B-130 RC-B-132: a move that fails settles its action and leaves the staged file where it was")
    void aFailedMoveKeepsTheStagedFile() throws Exception {
        byte[] bytes = new byte[1500];
        Arrays.fill(bytes, (byte) 4);
        Files.write(sftpRoot().resolve("taken.bin"), new byte[] {1});
        ArtifactUuid uuid = stage(bytes);
        ResolvedTarget target = targets.target();

        OperationId id = placed(staged.place(new StagedPlacementRequest(OWNER, uuid, StagedActionKind.MOVE, newKey().value(), target, target.revision(),
            new PosixRemotePath("/taken.bin"), OverwriteMode.FAIL_IF_EXISTS, Elevation.NONE)));
        intake.approve(id, APPROVED_BY_OWNER);

        assertThat(awaitTerminal(id).state()).isEqualTo(OperationState.FAILED);
        assertThat(Files.readAllBytes(sftpRoot().resolve("taken.bin"))).as("the file of the target is unchanged").isEqualTo(new byte[] {1});
        ArtifactRecord source = registry.findStaged(uuid).orElseThrow();
        await().atMost(LIMIT).untilAsserted(() -> assertThat(registry.actions(source.id())).extracting(StagedAction::state).containsExactly(StagedActionState.SETTLED));
        assertThat(registry.find(source.id()).orElseThrow().state()).as("the staged file is still there").isEqualTo(ArtifactState.READY);
    }

    @Test
    @DisplayName("S3-UC-08: a download reads the file from the SFTP root of the server into a verified, ready artifact")
    void aDownloadIsStoredThroughSftp() throws Exception {
        byte[] served = new byte[850];
        Arrays.fill(served, (byte) 5);
        Files.write(sftpRoot().resolve("served.bin"), served);
        ResolvedTarget target = targets.target();

        DownloadExecution execution = downloads.download(new DownloadJob(target, target.revision(), new DownloadInput(new PosixRemotePath("/served.bin"), Elevation.NONE,
            new FileBinding.Bound(new FileTargetBinding(EmbeddedTargets.ID, target.revision())), new Utf8Text("caller"), new Utf8Text("display"))),
            new ExecutionControl(new CancelSource(), () -> { }));

        assertThat(execution).isInstanceOf(DownloadExecution.Stored.class);
        ArtifactRecord artifact = ((DownloadExecution.Stored) execution).artifact();
        assertThat(artifact.spec().sizeBytes()).isEqualTo(served.length);
        assertThat(execution.outcome().verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(registry.find(artifact.id()).orElseThrow()).isEqualTo(artifact);
    }

    /** A complete staged file of the owner. */
    private ArtifactUuid stage(byte[] bytes) {
        ArtifactUuid uuid = ((StagedBegin.Begun) staged.begin(OWNER, newKey().value(), new FileName("staged.bin"), bytes.length)).uuid();
        staged.append(OWNER, uuid, 0, bytes, DIGEST.digest(bytes));
        staged.complete(OWNER, uuid);
        return uuid;
    }

    private static OperationId placed(StagedPlacement placement) {
        assertThat(placement).isInstanceOf(StagedPlacement.Placed.class);
        return ((StagedPlacement.Placed) placement).operation();
    }

    private NewOperation command(String text) {
        return NewOperation.of(digester, newKey(), OWNER, EmbeddedTargets.ID, targets.target().revision(), EmbeddedTargets.WRITE_PROFILE,
            new CommandInput(new CommandText(text), new Utf8Text("caller"), new Utf8Text("display")), new ConflictKey.None(), new Deadline.None());
    }

    private static RequestKey newKey() {
        return new RequestKey("full-" + UUID.randomUUID());
    }

    private Path sftpRoot() {
        return server.sftpRoot().orElseThrow();
    }

    /** Waits until the operation is in a terminal state; the dispatcher works on its own threads, so the test looks at the journal until it gets there. */
    private Operation awaitTerminal(OperationId id) {
        await().atMost(LIMIT).until(() -> journal.find(id).orElseThrow().state().isTerminal());
        return journal.find(id).orElseThrow();
    }

    /** The stored text of the output of the execution; empty until the output is ready. */
    private String outputOf(OperationId id) throws IOException {
        Optional<OutputManifest> found = manifests.inState(OutputState.READY).stream().filter(candidate -> candidate.binding().executionId().equals(id)).findFirst();
        if (found.isEmpty()) {
            return "";
        }
        OutputManifest manifest = found.orElseThrow();
        FormatSpan span = manifest.formats().spans().get(OutputFormat.TEXT);
        try (PayloadRead read = payloads.openFormat(manifest.id(), OutputFormat.TEXT, span)) {
            return new String(Channels.newInputStream(read.channel()).readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
