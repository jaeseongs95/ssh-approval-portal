package io.github.jaeseongs95.portal.app.remote;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.app.cli.CliVersion;
import io.github.jaeseongs95.portal.app.cli.RemoteStatus;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.operation.CompletionEvidence;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.path.PathSyntax;
import io.github.jaeseongs95.portal.domain.target.AccessMode;
import io.github.jaeseongs95.portal.domain.target.AuthMethod;
import io.github.jaeseongs95.portal.domain.target.ConnectionProfile;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.Setting;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.target.TtyMode;

/**
 * The sealed results of the ports. Each {@code switch} below has no {@code default}: a variant added to a result without a decision here does not compile, which is how
 * "a confirmed refusal" and "an outcome that is not known" stay apart (stage 3 design 2.2, 4.2, 6.2).
 */
class RemoteResultsTest {

    private static final Instant T0 = Instant.parse("2026-11-12T00:00:00Z");
    private static final Digest DIGEST = new Digest("c".repeat(64));

    private static String name(UploadResult result) {
        return switch (result) {
            case UploadResult.Published published -> "published";
            case UploadResult.Refused refused -> "refused";
            case UploadResult.RolledBack rolledBack -> "rolled-back";
            case UploadResult.Unconfirmed unconfirmed -> "unconfirmed";
            case UploadResult.NotDispatched notDispatched -> "not-dispatched";
        };
    }

    private static String name(DownloadResult result) {
        return switch (result) {
            case DownloadResult.Fetched fetched -> "fetched";
            case DownloadResult.Refused refused -> "refused";
            case DownloadResult.TooLarge tooLarge -> "too-large";
            case DownloadResult.Failed failed -> "failed";
        };
    }

    private static String name(PermissionResult result) {
        return switch (result) {
            case PermissionResult.Applied applied -> "applied";
            case PermissionResult.Unsupported unsupported -> "unsupported";
            case PermissionResult.Refused refused -> "refused";
            case PermissionResult.Unconfirmed unconfirmed -> "unconfirmed";
            case PermissionResult.NotDispatched notDispatched -> "not-dispatched";
        };
    }

    private static String name(ElevationResult result) {
        return switch (result) {
            case ElevationResult.Granted granted -> "granted";
            case ElevationResult.Denied denied -> "denied";
            case ElevationResult.NotApplicable notApplicable -> "not-applicable";
            case ElevationResult.Unavailable unavailable -> "unavailable";
        };
    }

    private static String name(AgentCliInstallResult result) {
        return switch (result) {
            case AgentCliInstallResult.Installed installed -> "installed";
            case AgentCliInstallResult.Reused reused -> "reused";
            case AgentCliInstallResult.Refused refused -> "refused";
            case AgentCliInstallResult.RolledBack rolledBack -> "rolled-back";
            case AgentCliInstallResult.Unconfirmed unconfirmed -> "unconfirmed";
            case AgentCliInstallResult.NotDispatched notDispatched -> "not-dispatched";
        };
    }

    private static String name(PathPolicyDecision decision) {
        return switch (decision) {
            case PathPolicyDecision.Enforce enforce -> "enforce";
            case PathPolicyDecision.Bypass bypass -> "bypass";
            case PathPolicyDecision.NotApplicable notApplicable -> "not-applicable";
            case PathPolicyDecision.Unconfirmed unconfirmed -> "unconfirmed";
        };
    }

    private static String name(UnconfirmedCause cause) {
        return switch (cause) {
            case UnconfirmedCause.TransportLost transportLost -> "transport-lost";
            case UnconfirmedCause.RestoreUnconfirmed restoreUnconfirmed -> "restore:" + restoreUnconfirmed.leftoverName();
            case UnconfirmedCause.DurabilityUnconfirmed durabilityUnconfirmed -> "durability";
            case UnconfirmedCause.CleanupUnconfirmed cleanupUnconfirmed -> "cleanup:" + cleanupUnconfirmed.leftoverName();
        };
    }

    private static String name(FileDiagnostic diagnostic) {
        return switch (diagnostic) {
            case FileDiagnostic.None none -> "none";
            case FileDiagnostic.SftpStatus status -> "sftp:" + status.code();
            case FileDiagnostic.NoSpace noSpace -> "no-space";
        };
    }

    private static String name(ElevationPlan plan) {
        return switch (plan) {
            case ElevationPlan.SudoNonInteractive sudo -> "sudo";
            case ElevationPlan.WindowsAdministratorCheck windows -> "windows";
            case ElevationPlan.NotSupported notSupported -> "not-supported";
        };
    }

    private static String name(PermissionSupport support) {
        return switch (support) {
            case PermissionSupport.Supported supported -> "supported";
            case PermissionSupport.Unsupported unsupported -> "unsupported:" + unsupported.reason();
        };
    }

    private static String name(ProfileLookup lookup) {
        return switch (lookup) {
            case ProfileLookup.Found found -> "found";
            case ProfileLookup.NotConfigured notConfigured -> "not-configured:" + notConfigured.alias().value();
        };
    }

    @Test
    @DisplayName("S3-SF-04 S3-SF-05 an upload is published, refused, rolled back, unconfirmed or not dispatched, and only Published can settle the operation as completed")
    void uploadResultsKeepRefusalAndUncertaintyApart() {
        UploadResult.Published published = new UploadResult.Published(DIGEST, T0, ReplaceMethod.POSIX_RENAME);
        List<UploadResult> all = List.of(published, new UploadResult.Refused(TransferErrorCode.DESTINATION_EXISTS, new FileDiagnostic.None(), CleanupState.COMPLETE),
            new UploadResult.RolledBack(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.SftpStatus(3), new RestoreEvidence(T0)),
            new UploadResult.Unconfirmed(new UnconfirmedCause.TransportLost(), CleanupState.INCOMPLETE), new UploadResult.NotDispatched(TransferFailureCause.CONNECT_FAILED));
        assertThat(all.stream().map(RemoteResultsTest::name).toList()).containsExactly("published", "refused", "rolled-back", "unconfirmed", "not-dispatched");
        assertThat(published.evidence()).isEqualTo(new CompletionEvidence.FilePublished(T0, DIGEST));
        assertThat(published.evidence().confirmsCompletion()).isTrue();
        assertThatThrownBy(() -> new UploadResult.Published(DIGEST, T0, null)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new UploadResult.RolledBack(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.None(), null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("S3-SF-05 an unconfirmed upload names its cause; a leftover file is named, and every cause is an outcome the owner reconciles")
    void unconfirmedCausesAreNamed() {
        assertThat(name(new UnconfirmedCause.RestoreUnconfirmed(".ssh-approval-bak-1"))).isEqualTo("restore:.ssh-approval-bak-1");
        assertThat(name(new UnconfirmedCause.CleanupUnconfirmed(".ssh-approval-1.part"))).isEqualTo("cleanup:.ssh-approval-1.part");
        assertThat(name(new UnconfirmedCause.DurabilityUnconfirmed())).isEqualTo("durability");
        assertThat(name(new UnconfirmedCause.TransportLost())).isEqualTo("transport-lost");
        assertThatThrownBy(() -> new UnconfirmedCause.CleanupUnconfirmed(" ")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new UnconfirmedCause.RestoreUnconfirmed("x".repeat(256))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S3-SF-06 S3-SF-07 S3-SF-08 S3-SF-09 a download is fetched, refused, too large or failed; a fetched file is verified, a too-large one is above its limit")
    void downloadResultsReadOnly() {
        DownloadResult.Fetched fetched = new DownloadResult.Fetched(850, DIGEST);
        List<DownloadResult> all = List.of(fetched, new DownloadResult.Refused(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.SftpStatus(3)),
            new DownloadResult.TooLarge(64L * 1024 * 1024 + 1, 64L * 1024 * 1024), new DownloadResult.Failed(TransferFailureCause.TRANSPORT_LOST));
        assertThat(all.stream().map(RemoteResultsTest::name).toList()).containsExactly("fetched", "refused", "too-large", "failed");
        assertThat(fetched.evidence()).isEqualTo(new CompletionEvidence.FileRead(true));
        assertThat(fetched.evidence().confirmsCompletion()).isTrue();
        assertThat(new DownloadResult.Fetched(0, DIGEST).size()).isZero();
        assertThatThrownBy(() -> new DownloadResult.Fetched(-1, DIGEST)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new DownloadResult.TooLarge(10, 10)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new DownloadResult.TooLarge(10, 0)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S3-SF-10 a shortage of space on the target is a diagnostic of its own, not a permission refusal")
    void noSpaceIsNotAPermissionProblem() {
        assertThat(name(new FileDiagnostic.NoSpace())).isEqualTo("no-space").isNotEqualTo(name(new FileDiagnostic.SftpStatus(3)));
        assertThat(name(new FileDiagnostic.None())).isEqualTo("none");
        assertThatThrownBy(() -> new FileDiagnostic.SftpStatus(-1)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S3-SF-11 a target that cannot set permission bits answers Unsupported with a reason, and the results are five closed variants")
    void permissionResults() {
        List<PermissionResult> all = List.of(new PermissionResult.Applied(), new PermissionResult.Unsupported(UnsupportedReason.WINDOWS_SFTP_CHMOD),
            new PermissionResult.Refused(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.None()), new PermissionResult.Unconfirmed(new UnconfirmedCause.TransportLost()),
            new PermissionResult.NotDispatched(TransferFailureCause.DEADLINE));
        assertThat(all.stream().map(RemoteResultsTest::name).toList()).containsExactly("applied", "unsupported", "refused", "unconfirmed", "not-dispatched");
        assertThat(name(new PermissionSupport.Unsupported(UnsupportedReason.WINDOWS_SFTP_CHMOD))).isEqualTo("unsupported:WINDOWS_SFTP_CHMOD");
        assertThat(name(new PermissionSupport.Supported())).isEqualTo("supported");
        assertThatThrownBy(() -> new PermissionResult.Unsupported(null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("S3-EL-03 S3-EL-04 an elevation check is granted, denied, not applicable to an operating system, or unavailable; a plan is one of three values")
    void elevationResultsAndPlans() {
        FixedRemoteCommand probe = new FixedRemoteCommand("admin-probe", "whoami /groups");
        List<ElevationResult> all = List.of(new ElevationResult.Granted(), new ElevationResult.Denied(), new ElevationResult.NotApplicable(TargetOs.LINUX),
            new ElevationResult.Unavailable(TransferFailureCause.CANCELLED));
        assertThat(all.stream().map(RemoteResultsTest::name).toList()).containsExactly("granted", "denied", "not-applicable", "unavailable");
        List<ElevationPlan> plans = List.of(new ElevationPlan.SudoNonInteractive(probe), new ElevationPlan.WindowsAdministratorCheck(probe), new ElevationPlan.NotSupported());
        assertThat(plans.stream().map(RemoteResultsTest::name).toList()).containsExactly("sudo", "windows", "not-supported");
    }

    @Test
    @DisplayName("S3-SF-15 the path policy answers enforce, bypass, not applicable or unconfirmed")
    void pathPolicyDecisions() {
        List<PathPolicyDecision> all = List.of(new PathPolicyDecision.Enforce(PathSyntax.WINDOWS.path("C:\\root")), new PathPolicyDecision.Bypass(),
            new PathPolicyDecision.NotApplicable(), new PathPolicyDecision.Unconfirmed());
        assertThat(all.stream().map(RemoteResultsTest::name).toList()).containsExactly("enforce", "bypass", "not-applicable", "unconfirmed");
    }

    @Test
    @DisplayName("S3-SS-08 S3-SS-10 a profile lookup is found or not configured by name")
    void profileLookups() {
        ProfileAlias alias = new ProfileAlias("jump-1");
        ConnectionProfile profile = new ConnectionProfile("host.example", 22, "deploy", Setting.unset(), Setting.unset(), AuthMethod.AGENT, Setting.unset(), Setting.unset(),
            AccessMode.READ_WRITE, TtyMode.NO_TTY);
        assertThat(name(new ProfileLookup.NotConfigured(alias))).isEqualTo("not-configured:jump-1");
        assertThat(name(new ProfileLookup.Found(profile))).isEqualTo("found");
        assertThatThrownBy(() -> new ProfileLookup.Found(null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("S3-AG-05 S3-AG-06 S3-AG-08 an installation is installed, reused, refused, rolled back, unconfirmed or not dispatched; a failed-removal count is not negative")
    void installResults() {
        CliVersion version = new CliVersion("1.2.3");
        List<AgentCliInstallResult> all = List.of(new AgentCliInstallResult.Installed(version, 0, T0), new AgentCliInstallResult.Reused(version),
            new AgentCliInstallResult.Refused(AgentCliRefusal.PACKAGE_INTEGRITY_MISMATCH),
            new AgentCliInstallResult.RolledBack(AgentCliRefusal.INSTALL_COMMAND_FAILED, new RestoreEvidence(T0), 1),
            new AgentCliInstallResult.Unconfirmed(new UnconfirmedCause.TransportLost(), 2), new AgentCliInstallResult.NotDispatched(TransferFailureCause.CHANNEL_OPEN_FAILED));
        assertThat(all.stream().map(RemoteResultsTest::name).toList()).containsExactly("installed", "reused", "refused", "rolled-back", "unconfirmed", "not-dispatched");
        assertThat(new AgentCliInstallResult.Installed(version, 0, T0).cleanupFailures()).isZero();
        assertThatThrownBy(() -> new AgentCliInstallResult.Installed(version, -1, T0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AgentCliInstallResult.Unconfirmed(new UnconfirmedCause.TransportLost(), -1)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S3-AG-07 a status answer carries the installation, its revision and the login state; a failed question changes nothing")
    void statusResults() {
        AgentCliStatusResult observed = new AgentCliStatusResult.Observed(new RemoteStatus.NotFound(), DIGEST, LoginState.NOT_INSTALLED);
        AgentCliStatusResult failed = new AgentCliStatusResult.Failed(TransferFailureCause.TRANSPORT_LOST);
        for (AgentCliStatusResult result : List.of(observed, failed)) {
            String text = switch (result) {
                case AgentCliStatusResult.Observed seen -> "observed:" + seen.login();
                case AgentCliStatusResult.Failed lost -> "failed:" + lost.cause();
            };
            assertThat(text).isNotBlank();
        }
        assertThat(LoginState.values()).containsExactly(LoginState.SIGNED_IN, LoginState.SIGNED_OUT, LoginState.NOT_INSTALLED);
    }

    @Test
    @DisplayName("S3-EX-01 an execution report holds the domain outcome and the timeline, and the outcome decides the state as the domain says")
    void executionReportKeepsTheDomainOutcome() {
        ExecutionOutcome outcome = ExecutionOutcome.exited(0, List.of());
        ExecutionReport report = new ExecutionReport(outcome, ExecutionTimeline.empty().marked(ExecutionPhase.CONNECT_STARTED, T0));
        assertThat(report.outcome().verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(report.timeline().marks()).hasSize(1);
        assertThatThrownBy(() -> new ExecutionReport(null, ExecutionTimeline.empty())).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new ExecutionReport(outcome, null)).isInstanceOf(NullPointerException.class);
    }
}
