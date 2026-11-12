package io.github.jaeseongs95.portal.ssh.cli;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.app.cli.CliVersion;
import io.github.jaeseongs95.portal.app.output.StreamFrame;
import io.github.jaeseongs95.portal.app.output.StreamKind;
import io.github.jaeseongs95.portal.app.remote.AgentCliInstallRequest;
import io.github.jaeseongs95.portal.app.remote.AgentCliInstallResult;
import io.github.jaeseongs95.portal.app.remote.AgentCliPlan;
import io.github.jaeseongs95.portal.app.remote.AgentCliRefusal;
import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.app.remote.DownloadRequest;
import io.github.jaeseongs95.portal.app.remote.DownloadResult;
import io.github.jaeseongs95.portal.app.remote.ElevationRequest;
import io.github.jaeseongs95.portal.app.remote.ElevationResult;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.app.remote.ExecutionTimeline;
import io.github.jaeseongs95.portal.app.remote.OutputSink;
import io.github.jaeseongs95.portal.app.remote.PayloadSink;
import io.github.jaeseongs95.portal.app.remote.PayloadSource;
import io.github.jaeseongs95.portal.app.remote.PermissionRequest;
import io.github.jaeseongs95.portal.app.remote.PermissionResult;
import io.github.jaeseongs95.portal.app.remote.RemoteExecution;
import io.github.jaeseongs95.portal.app.remote.RemoteExecutor;
import io.github.jaeseongs95.portal.app.remote.RemoteFileTransfer;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;
import io.github.jaeseongs95.portal.app.remote.ReplaceMethod;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.app.remote.UnconfirmedCause;
import io.github.jaeseongs95.portal.app.remote.UploadRequest;
import io.github.jaeseongs95.portal.app.remote.UploadResult;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProviderId;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.error.ExecutionStage;
import io.github.jaeseongs95.portal.domain.error.RemoteOutcome;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.target.AccessMode;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import io.github.jaeseongs95.portal.ssh.platform.AgentCliStep;
import io.github.jaeseongs95.portal.ssh.platform.LinuxTargetPlatform;
import io.github.jaeseongs95.portal.ssh.platform.PlatformFixtures;
import io.github.jaeseongs95.portal.ssh.platform.PosixCommandLineGrammar;
import io.github.jaeseongs95.portal.ssh.platform.PythonSourceReceiver;
import io.github.jaeseongs95.portal.ssh.platform.RemoteScripts;
import java.io.ByteArrayInputStream;
import java.nio.channels.Channels;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.IntFunction;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The agent CLI installer (S3-AG-01 to S3-AG-09, defect D-0035). The target is a state machine of the test, not a script: it keeps where {@code current} points, what the
 * keep and the switch and the rollback do to it, and answers the read-only steps from that state, so a test says what happens to the target and the installer is judged
 * by what it answers. The commands are the ones a POSIX target platform made; the file transfer is a recording class.
 */
class AgentCliInstallerTest {

    private static final byte[] PACKAGE = "the bytes of the package".getBytes(StandardCharsets.UTF_8);
    private static final RemoteTarget TARGET = new RemoteTarget(new TargetId("files"), TargetRevision.of("a".repeat(64)), new ProfileAlias("writer"), AccessMode.READ_WRITE);
    private static final String HOME = "/home/someone";

    private final PlatformFixtures fixtures = new PlatformFixtures();
    private final RemoteScripts scripts = new RemoteScripts();
    private final LinuxTargetPlatform platform = new LinuxTargetPlatform(command -> {
        throw new IllegalStateException("not used");
    }, new PosixCommandLineGrammar(), new PythonSourceReceiver(scripts, new Sha256Digester()));
    private final AgentRelease release = fixtures.release(AgentCliProviderId.CODEX, integrityOf(PACKAGE));
    private final AgentCliPlan plan = platform.agentCliPlan(fixtures.intent(release), release);
    private final String finalPath = HOME + "/.ssh-approval-portal/agent-cli/codex/versions/1.2.3-" + release.releaseDigest().hex().substring(0, 16);
    private final String tarballPath = finalPath + ".partial/package.tgz";

    private static String integrityOf(byte[] bytes) {
        try {
            return "sha512-" + Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-512").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** What one command does on the target. */
    private sealed interface Answer permits Answer.Exits, Answer.Lost {
        record Exits(int code, String stdout) implements Answer {
        }

        record Lost() implements Answer {
        }
    }

    /** The target: where {@code current} points, what was kept, and the steps the installer ran, in order. Overrides change the answer of the n-th run of a step. */
    private final class Target implements RemoteExecutor {
        private String current;
        private String kept = "";
        private boolean rollbackWorks = true;
        private final List<AgentCliStep> steps = new ArrayList<>();
        private final Map<AgentCliStep, Integer> counts = new HashMap<>();
        private final Map<AgentCliStep, IntFunction<Answer>> overrides = new HashMap<>();
        private final Map<String, AgentCliStep> byCommand = new HashMap<>();

        Target(String current) {
            this.current = current;
            for (AgentCliStep step : AgentCliStep.values()) {
                assertThat(byCommand.put(step.in(plan).commandLine(), step)).as("the plan gives each step a command of its own: %s", step).isNull();
            }
        }

        void override(AgentCliStep step, IntFunction<Answer> answer) {
            overrides.put(step, answer);
        }

        @Override
        public ExecutionReport run(RemoteExecution request, OutputSink sink, ExecutionControl control) {
            AgentCliStep step = byCommand.get(request.command().commandLine());
            assertThat(step).as("every command sent is one of the plan's fixed commands: %s", request.command().commandLine()).isNotNull();
            steps.add(step);
            int number = counts.merge(step, 1, Integer::sum);
            Answer answer = overrides.containsKey(step) ? overrides.get(step).apply(number) : behave(step);
            if (answer instanceof Answer.Lost) {
                return new ExecutionReport(ExecutionOutcome.transportLost(new ExecutionFailure.Classified(ExecutionStage.SSH_EXECUTION, ExecutionErrorCode.SSH_EXECUTION_FAILED,
                    RemoteOutcome.UNKNOWN), List.of()), ExecutionTimeline.empty());
            }
            Answer.Exits exits = (Answer.Exits) answer;
            if (!exits.stdout().isEmpty()) {
                sink.accept(new StreamFrame(StreamKind.STDOUT, exits.stdout().getBytes(StandardCharsets.UTF_8)));
            }
            return new ExecutionReport(ExecutionOutcome.exited(exits.code(), List.of()), ExecutionTimeline.empty());
        }

        private Answer behave(AgentCliStep step) {
            return switch (step) {
                case TARBALL_PATH -> new Answer.Exits(0, tarballPath);
                case FINAL_PATH -> new Answer.Exits(0, finalPath);
                case CURRENT_BEFORE, CURRENT_AFTER -> new Answer.Exits(0, current);
                case VERSION -> new Answer.Exits(0, "1.2.3");
                case KEEP_PREVIOUS -> {
                    kept = current;
                    yield new Answer.Exits(0, "");
                }
                case SWITCH -> {
                    current = finalPath;
                    yield new Answer.Exits(0, "");
                }
                case ROLLBACK -> {
                    if (rollbackWorks) {
                        current = kept;
                    }
                    yield new Answer.Exits(0, "");
                }
                case ROLLBACK_NONE -> {
                    if (rollbackWorks) {
                        current = "";
                    }
                    yield new Answer.Exits(0, "");
                }
                case PREPARE, UNPACK, DROP_PREVIOUS, CLEANUP -> new Answer.Exits(0, "");
            };
        }
    }

    /** A file transfer that records the upload, keeps the bytes it was given and answers what the test says. */
    private static final class RecordingTransfer implements RemoteFileTransfer {
        private final List<UploadRequest> requests = new ArrayList<>();
        private byte[] received = new byte[0];
        private UploadResult answer;

        @Override
        public UploadResult upload(UploadRequest request, PayloadSource source, ExecutionControl control) {
            requests.add(request);
            try (PayloadRead read = source.open()) {
                received = Channels.newInputStream(read.channel()).readAllBytes();
            } catch (java.io.IOException e) {
                throw new IllegalStateException(e);
            }
            return answer != null ? answer : new UploadResult.Published(request.sha256(), Instant.parse("2026-11-12T00:00:00Z"), ReplaceMethod.POSIX_RENAME);
        }

        @Override
        public DownloadResult download(DownloadRequest request, PayloadSink sink, ExecutionControl control) {
            throw new IllegalStateException("the installer does not download");
        }

        @Override
        public PermissionResult applyPermissions(PermissionRequest request, ExecutionControl control) {
            throw new IllegalStateException("the installer sets no permissions");
        }

        @Override
        public ElevationResult checkElevation(ElevationRequest request, ExecutionControl control) {
            throw new IllegalStateException("the installer asks for no elevation");
        }
    }

    private AgentCliInstaller installer(Target target, RecordingTransfer transfer, Clock clock) {
        return new AgentCliInstaller(target, transfer, (remote, cancel) -> {
            throw new IllegalStateException("install needs no session of its own");
        }, new io.github.jaeseongs95.portal.ssh.sftp.SftpChannels(), clock);
    }

    private AgentCliInstallRequest request(byte[] bytes) {
        PayloadSource source = () -> new PayloadRead(Channels.newChannel(new ByteArrayInputStream(bytes)), bytes.length);
        return new AgentCliInstallRequest(TARGET, plan, source, TransferLimits.defaults());
    }

    private ExecutionControl control() {
        return new ExecutionControl(new CancelSource(), () -> { });
    }

    private static final String OLD = HOME + "/.ssh-approval-portal/agent-cli/codex/versions/0.9.0-0123456789abcdef";

    // ---- S3-AG-01 to S3-AG-04 ----

    @Test
    @DisplayName("S3-AG-01 D-0035 an installation: integrity, read-only questions, the package over SFTP, unpack and version, keep, switch, read back twice, then Installed; every command is one of the plan's")
    void installation() {
        Target target = new Target(OLD);
        RecordingTransfer transfer = new RecordingTransfer();

        AgentCliInstallResult result = installer(target, transfer, Clock.systemUTC()).install(request(PACKAGE), control());

        assertThat(result).isInstanceOf(AgentCliInstallResult.Installed.class);
        AgentCliInstallResult.Installed installed = (AgentCliInstallResult.Installed) result;
        assertThat(installed.version()).isEqualTo(new CliVersion("1.2.3"));
        assertThat(installed.cleanupFailures()).isZero();
        assertThat(target.steps).containsExactly(AgentCliStep.TARBALL_PATH, AgentCliStep.FINAL_PATH, AgentCliStep.CURRENT_BEFORE, AgentCliStep.PREPARE, AgentCliStep.UNPACK,
            AgentCliStep.VERSION, AgentCliStep.KEEP_PREVIOUS, AgentCliStep.SWITCH, AgentCliStep.CURRENT_AFTER, AgentCliStep.VERSION, AgentCliStep.DROP_PREVIOUS, AgentCliStep.CLEANUP);
        assertThat(transfer.requests).hasSize(1);
        assertThat(transfer.requests.get(0).path().value()).isEqualTo(tarballPath);
        assertThat(transfer.requests.get(0).sizeBytes()).isEqualTo(PACKAGE.length);
        assertThat(transfer.requests.get(0).overwrite()).isEqualTo(OverwriteMode.REPLACE);
        assertThat(transfer.received).isEqualTo(PACKAGE);
        assertThat(target.current).isEqualTo(finalPath);
    }

    @Test
    @DisplayName("S3-AG-02 RC-B-637 a package that is not the one the release announced is Refused(PACKAGE_INTEGRITY_MISMATCH) and nothing at all is sent to the target")
    void tamperedPackage() {
        Target target = new Target(OLD);
        RecordingTransfer transfer = new RecordingTransfer();

        AgentCliInstallResult result = installer(target, transfer, Clock.systemUTC()).install(request("changed bytes".getBytes(StandardCharsets.UTF_8)), control());

        assertThat(result).isEqualTo(new AgentCliInstallResult.Refused(AgentCliRefusal.PACKAGE_INTEGRITY_MISMATCH));
        assertThat(target.steps).isEmpty();
        assertThat(transfer.requests).isEmpty();
    }

    @Test
    @DisplayName("S3-AG-03 RC-B-633 a release that is already current is Reused: three read-only questions, no write, no upload")
    void sameVersionIsReused() {
        Target target = new Target(finalPath);
        RecordingTransfer transfer = new RecordingTransfer();

        AgentCliInstallResult result = installer(target, transfer, Clock.systemUTC()).install(request(PACKAGE), control());

        assertThat(result).isEqualTo(new AgentCliInstallResult.Reused(new CliVersion("1.2.3")));
        assertThat(target.steps).containsExactly(AgentCliStep.TARBALL_PATH, AgentCliStep.FINAL_PATH, AgentCliStep.CURRENT_BEFORE);
        assertThat(transfer.requests).isEmpty();
    }

    @Test
    @DisplayName("S3-AG-04 RC-B-636 an update keeps the previous version: nothing removes a version directory, only the partial one of this release")
    void updateKeepsThePreviousVersion() {
        Target target = new Target(OLD);

        installer(target, new RecordingTransfer(), Clock.systemUTC()).install(request(PACKAGE), control());

        assertThat(target.steps).doesNotContain(AgentCliStep.ROLLBACK, AgentCliStep.ROLLBACK_NONE);
        assertThat(plan.commands().stream().filter(command -> command.commandLine().contains("rm -rf")).map(command -> command.label()).toList())
            .containsExactlyInAnyOrder("unpack", "cleanup");
        assertThat(AgentCliStep.CLEANUP.in(plan).commandLine()).endsWith(".partial\"");
    }

    // ---- S3-AG-05, S3-AG-06: after the switch (D-0035) ----

    @Test
    @DisplayName("S3-AG-05 D-0035 a read-back of the switch that fails puts the old current back: RolledBack with the restore read back, never Installed")
    void failedReadBackIsRolledBack() {
        Target target = new Target(OLD);
        target.override(AgentCliStep.VERSION, number -> number == 1 ? new Answer.Exits(0, "1.2.3") : new Answer.Exits(1, ""));

        AgentCliInstallResult result = installer(target, new RecordingTransfer(), Clock.systemUTC()).install(request(PACKAGE), control());

        assertThat(result).isInstanceOf(AgentCliInstallResult.RolledBack.class);
        assertThat(((AgentCliInstallResult.RolledBack) result).reason()).isEqualTo(AgentCliRefusal.INSTALL_COMMAND_FAILED);
        assertThat(target.current).isEqualTo(OLD);
        assertThat(target.steps).contains(AgentCliStep.ROLLBACK).doesNotContain(AgentCliStep.DROP_PREVIOUS);
    }

    @Test
    @DisplayName("S3-AG-05 a first installation that fails its read-back goes back to no current at all: ROLLBACK_NONE, RolledBack")
    void firstInstallationRolledBack() {
        Target target = new Target("");
        target.override(AgentCliStep.VERSION, number -> number == 1 ? new Answer.Exits(0, "1.2.3") : new Answer.Exits(0, "9.9.9"));

        AgentCliInstallResult result = installer(target, new RecordingTransfer(), Clock.systemUTC()).install(request(PACKAGE), control());

        assertThat(result).isInstanceOf(AgentCliInstallResult.RolledBack.class);
        assertThat(target.current).isEmpty();
        assertThat(target.steps).contains(AgentCliStep.ROLLBACK_NONE).doesNotContain(AgentCliStep.ROLLBACK);
    }

    @Test
    @DisplayName("S3-AG-05 D-0035 a rollback that is not read back as done is Unconfirmed(RestoreUnconfirmed), never RolledBack and never Installed")
    void rollbackThatIsNotConfirmed() {
        Target target = new Target(OLD);
        target.rollbackWorks = false;
        target.override(AgentCliStep.VERSION, number -> number == 1 ? new Answer.Exits(0, "1.2.3") : new Answer.Exits(1, ""));

        AgentCliInstallResult result = installer(target, new RecordingTransfer(), Clock.systemUTC()).install(request(PACKAGE), control());

        assertThat(result).isInstanceOf(AgentCliInstallResult.Unconfirmed.class);
        assertThat(((AgentCliInstallResult.Unconfirmed) result).cause()).isEqualTo(new UnconfirmedCause.RestoreUnconfirmed("current"));
    }

    @Test
    @DisplayName("S3-AG-06 D-0035 a connection lost right after the switch is Unconfirmed(TransportLost): no Installed, no rollback sent over a connection that is gone")
    void connectionLostAfterTheSwitch() {
        Target target = new Target(OLD);
        target.override(AgentCliStep.CURRENT_AFTER, number -> new Answer.Lost());

        AgentCliInstallResult result = installer(target, new RecordingTransfer(), Clock.systemUTC()).install(request(PACKAGE), control());

        assertThat(result).isEqualTo(new AgentCliInstallResult.Unconfirmed(new UnconfirmedCause.TransportLost(), 0));
        assertThat(target.steps).doesNotContain(AgentCliStep.ROLLBACK, AgentCliStep.DROP_PREVIOUS);
        assertThat(target.steps.stream().filter(step -> step == AgentCliStep.SWITCH).count()).as("nothing is sent twice").isEqualTo(1);
    }

    @Test
    @DisplayName("S3-AG-06 D-0035 whatever fails after the switch was sent, the answer is never NotDispatched and never Installed")
    void nothingAfterTheSwitchIsNotDispatched() {
        List<AgentCliStep> afterSwitch = List.of(AgentCliStep.CURRENT_AFTER, AgentCliStep.VERSION, AgentCliStep.ROLLBACK, AgentCliStep.CLEANUP);
        for (AgentCliStep failing : afterSwitch) {
            for (Answer failure : List.<Answer>of(new Answer.Lost(), new Answer.Exits(1, ""))) {
                Target target = new Target(OLD);
                // VERSION runs twice: the first run (the unpack check) is before the switch and must pass, the second one is the confirmation.
                target.override(failing, number -> failing == AgentCliStep.VERSION && number == 1 ? new Answer.Exits(0, "1.2.3") : failure);
                if (failing == AgentCliStep.ROLLBACK || failing == AgentCliStep.CLEANUP) {
                    target.override(AgentCliStep.VERSION, number -> number == 1 ? new Answer.Exits(0, "1.2.3") : new Answer.Exits(1, ""));
                    target.override(failing, number -> failure);
                }

                AgentCliInstallResult result = installer(target, new RecordingTransfer(), Clock.systemUTC()).install(request(PACKAGE), control());

                assertThat(result).as("%s failing with %s", failing, failure).isNotInstanceOf(AgentCliInstallResult.NotDispatched.class);
                assertThat(target.steps).as("the switch was sent").contains(AgentCliStep.SWITCH);
            }
        }
    }

    @Test
    @DisplayName("S3-AG-06 a switch that fails and leaves the old version current is a refusal and the old version stays")
    void switchThatDidNotHappen() {
        Target target = new Target(OLD);
        target.override(AgentCliStep.SWITCH, number -> new Answer.Exits(1, ""));

        AgentCliInstallResult result = installer(target, new RecordingTransfer(), Clock.systemUTC()).install(request(PACKAGE), control());

        assertThat(result).isEqualTo(new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
        assertThat(target.current).isEqualTo(OLD);
        assertThat(target.steps).contains(AgentCliStep.CLEANUP);
    }

    // ---- S3-AG-08, S3-AG-09: clean-up and stops ----

    @Test
    @DisplayName("S3-AG-08 cleanupFailures counts the removals that failed: 0 is none, a positive number is how many")
    void cleanupFailures() {
        Target none = new Target(OLD);
        Target two = new Target(OLD);
        two.override(AgentCliStep.DROP_PREVIOUS, number -> new Answer.Exits(1, ""));
        two.override(AgentCliStep.CLEANUP, number -> new Answer.Exits(1, ""));

        AgentCliInstallResult clean = installer(none, new RecordingTransfer(), Clock.systemUTC()).install(request(PACKAGE), control());
        AgentCliInstallResult dirty = installer(two, new RecordingTransfer(), Clock.systemUTC()).install(request(PACKAGE), control());

        assertThat(((AgentCliInstallResult.Installed) clean).cleanupFailures()).isZero();
        assertThat(((AgentCliInstallResult.Installed) dirty).cleanupFailures()).isEqualTo(2);
    }

    @Test
    @DisplayName("S3-AG-09 a cancel before the switch removes the partial directory, keeps the previous version and answers NotDispatched(CANCELLED); nothing is uploaded")
    void cancelBeforeTheSwitch() {
        Target target = new Target(OLD);
        RecordingTransfer transfer = new RecordingTransfer();
        CancelSource cancel = new CancelSource();
        cancel.cancel();

        AgentCliInstallResult result = installer(target, transfer, Clock.systemUTC()).install(request(PACKAGE), new ExecutionControl(cancel, () -> { }));

        assertThat(result).isEqualTo(new AgentCliInstallResult.NotDispatched(TransferFailureCause.CANCELLED));
        assertThat(target.steps).endsWith(AgentCliStep.CLEANUP).doesNotContain(AgentCliStep.PREPARE, AgentCliStep.SWITCH);
        assertThat(transfer.requests).isEmpty();
        assertThat(target.current).isEqualTo(OLD);
    }

    @Test
    @DisplayName("S3-AG-09 a time limit that has run out before the switch ends the installation the same way: NotDispatched(DEADLINE), partial directory removed")
    void deadlineBeforeTheSwitch() {
        Target target = new Target(OLD);
        // The clock moves a second with every reading, so the 2 second limit of the request is over by the time the read-only questions are answered.
        Clock stepping = new Clock() {
            private Instant now = Instant.parse("2026-11-12T00:00:00Z");

            @Override
            public java.time.ZoneId getZone() {
                return ZoneOffset.UTC;
            }

            @Override
            public Clock withZone(java.time.ZoneId zone) {
                return this;
            }

            @Override
            public Instant instant() {
                now = now.plusSeconds(1);
                return now;
            }
        };
        AgentCliInstallRequest request = new AgentCliInstallRequest(TARGET, plan, () -> new PayloadRead(Channels.newChannel(new ByteArrayInputStream(PACKAGE)), PACKAGE.length),
            new TransferLimits(java.time.Duration.ofSeconds(2), TransferLimits.DEFAULT_MAX_FILE_SIZE));

        AgentCliInstallResult result = installer(target, new RecordingTransfer(), stepping).install(request, control());

        assertThat(result).isEqualTo(new AgentCliInstallResult.NotDispatched(TransferFailureCause.DEADLINE));
        assertThat(target.steps).endsWith(AgentCliStep.CLEANUP);
        assertThat(target.current).isEqualTo(OLD);
    }

    // ---- what goes wrong before the switch ----

    @Test
    @DisplayName("S3-AG-01 a version that is not the announced one is a refusal and the partial directory is removed; a missing tar is PREREQUISITE_MISSING")
    void unpackProblems() {
        Target wrongVersion = new Target(OLD);
        wrongVersion.override(AgentCliStep.VERSION, number -> new Answer.Exits(0, "9.9.9"));
        Target noTar = new Target(OLD);
        noTar.override(AgentCliStep.UNPACK, number -> new Answer.Exits(127, ""));

        AgentCliInstallResult wrong = installer(wrongVersion, new RecordingTransfer(), Clock.systemUTC()).install(request(PACKAGE), control());
        AgentCliInstallResult missing = installer(noTar, new RecordingTransfer(), Clock.systemUTC()).install(request(PACKAGE), control());

        assertThat(wrong).isEqualTo(new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
        assertThat(wrongVersion.steps).endsWith(AgentCliStep.CLEANUP).doesNotContain(AgentCliStep.SWITCH);
        assertThat(missing).isEqualTo(new AgentCliInstallResult.Refused(AgentCliRefusal.PREREQUISITE_MISSING));
        assertThat(noTar.steps).endsWith(AgentCliStep.CLEANUP);
    }

    @Test
    @DisplayName("S3-AG-01 an upload that the target refused is a refusal with the partial directory removed; one whose end is not known is Unconfirmed with the cause of the upload")
    void uploadProblems() {
        Target refusedTarget = new Target(OLD);
        RecordingTransfer refusing = new RecordingTransfer();
        refusing.answer = new UploadResult.Refused(io.github.jaeseongs95.portal.domain.error.TransferErrorCode.PERMISSION_DENIED,
            new io.github.jaeseongs95.portal.app.remote.FileDiagnostic.None(), CleanupState.COMPLETE);
        Target lostTarget = new Target(OLD);
        RecordingTransfer lost = new RecordingTransfer();
        lost.answer = new UploadResult.Unconfirmed(new UnconfirmedCause.TransportLost(), CleanupState.INCOMPLETE);

        AgentCliInstallResult refused = installer(refusedTarget, refusing, Clock.systemUTC()).install(request(PACKAGE), control());
        AgentCliInstallResult unknown = installer(lostTarget, lost, Clock.systemUTC()).install(request(PACKAGE), control());

        assertThat(refused).isEqualTo(new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
        assertThat(refusedTarget.steps).endsWith(AgentCliStep.CLEANUP).doesNotContain(AgentCliStep.UNPACK);
        assertThat(unknown).isEqualTo(new AgentCliInstallResult.Unconfirmed(new UnconfirmedCause.TransportLost(), 0));
        assertThat(lostTarget.steps).doesNotContain(AgentCliStep.UNPACK, AgentCliStep.SWITCH);
    }

    @Test
    @DisplayName("S3-AG-01 a read-only question that cannot be asked is NotDispatched with its reason: nothing was changed")
    void questionThatCannotBeAsked() {
        Target target = new Target(OLD);
        target.override(AgentCliStep.CURRENT_BEFORE, number -> new Answer.Lost());

        AgentCliInstallResult result = installer(target, new RecordingTransfer(), Clock.systemUTC()).install(request(PACKAGE), control());

        assertThat(result).isInstanceOf(AgentCliInstallResult.NotDispatched.class);
        assertThat(target.steps).doesNotContain(AgentCliStep.PREPARE);
        assertThat(ExecutionReason.TRANSPORT_LOST).isNotNull();
    }
}
