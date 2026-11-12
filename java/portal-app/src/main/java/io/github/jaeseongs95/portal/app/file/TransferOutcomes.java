package io.github.jaeseongs95.portal.app.file;

import java.time.Duration;
import java.util.List;
import java.util.Objects;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.artifact.ArtifactRefusal;
import io.github.jaeseongs95.portal.app.remote.DownloadResult;
import io.github.jaeseongs95.portal.app.remote.FileDiagnostic;
import io.github.jaeseongs95.portal.app.remote.PermissionResult;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.app.remote.UnconfirmedCause;
import io.github.jaeseongs95.portal.app.remote.UploadResult;
import io.github.jaeseongs95.portal.domain.error.ErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.error.ExecutionStage;
import io.github.jaeseongs95.portal.domain.error.RemoteOutcome;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.operation.CaptureState;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.operation.CompletionEvidence;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import io.github.jaeseongs95.portal.domain.operation.ExitStatus;
import io.github.jaeseongs95.portal.domain.operation.OutputState;
import io.github.jaeseongs95.portal.domain.operation.Reconciliation;
import io.github.jaeseongs95.portal.domain.operation.RemoteState;
import io.github.jaeseongs95.portal.domain.operation.ResultFlag;
import io.github.jaeseongs95.portal.domain.operation.SignalDelivery;
import io.github.jaeseongs95.portal.domain.operation.StreamCapture;
import io.github.jaeseongs95.portal.domain.operation.TimeoutMs;

/**
 * Turns what a file transfer answered into the {@link ExecutionOutcome} that the operation settles from. This is the one place that decides which transfer result is a
 * completion, a failure or an unknown outcome, so the decision of defect D-0035 (no completed operation without confirming evidence) and of decision D3-17 (a read-only
 * download never leaves the target in doubt) is written once.
 *
 * <ul>
 * <li><b>Upload.</b> Only {@link UploadResult.Published} carries evidence ({@link CompletionEvidence.FilePublished}), and only when the digest it confirmed is the digest the
 * owner approved. A failure after the replacement with the original confirmed back ({@code RolledBack}) is a failure; a result that is not known ({@code Unconfirmed}) is
 * {@code UNKNOWN} with the reconciliation required; a refusal before the replacement is a failure, unless the temporary file could not be removed, which is {@code UNKNOWN}.</li>
 * <li><b>Download.</b> Every failure is {@code NOT_DISPATCHED}, needs no reconciliation and is {@code FAILED}: a download changes nothing on the target, so there is nothing
 * to reconcile (D3-17). A reservation that the budget or the disk refused is the same, with the refusal's own code.</li>
 * </ul>
 *
 * <p>The sentences are fixed: a code name, a short sentence of the portal and typed numbers, never the text of a server or of an exception.
 */
@Component
public class TransferOutcomes {

    private static final ExecutionFailure OPERATION_NOT_STARTED = new ExecutionFailure.Classified(ExecutionStage.OPERATION, ExecutionErrorCode.OPERATION_FAILED,
        RemoteOutcome.NOT_STARTED);

    // ---- upload ----

    /** The outcome of an upload; {@code announced} is the digest the owner approved and {@code deadline} the time limit of the request. */
    public ExecutionOutcome upload(UploadResult result, Digest announced, Duration deadline) {
        Objects.requireNonNull(result, "result");
        Objects.requireNonNull(announced, "announced");
        Objects.requireNonNull(deadline, "deadline");
        return switch (result) {
            case UploadResult.Published published -> published.sha256().equals(announced) ? published(published) : unknown(ExecutionReason.EXIT, List.of(
                sentence(TransferErrorCode.FILE_CHANGED), "The published content does not have the digest the owner approved; compare the target before sending again."));
            case UploadResult.Refused refused -> refusedUpload(refused);
            case UploadResult.RolledBack rolledBack -> new ExecutionOutcome(ExecutionReason.EXIT, RemoteState.EXITED, new ExitStatus.Exited(1), SignalDelivery.NOT_SENT,
                CleanupState.COMPLETE, Reconciliation.NOT_REQUIRED, OutputState.NOT_REPORTED, CaptureState.NOT_REPORTED, new TimeoutMs.None(), new StreamCapture.NotCaptured(),
                new StreamCapture.NotCaptured(), new ExecutionFailure.Classified(ExecutionStage.OPERATION, ExecutionErrorCode.OPERATION_FAILED, RemoteOutcome.COMPLETED),
                ResultFlag.FAILED, texts(rolledBack.code(), rolledBack.diagnostic(), "The replacement failed and the original file was restored."),
                new CompletionEvidence.NoEvidence());
            case UploadResult.Unconfirmed unconfirmed -> unconfirmed(unconfirmed.cause());
            case UploadResult.NotDispatched notDispatched -> notDispatched(notDispatched.cause(), deadline);
        };
    }

    /**
     * The outcome of an upload that was published and whose permission bits were then asked for. The file is in place either way; an explicit mode that could not be
     * confirmed leaves the result in doubt, and the owner compares the target ({@code UNKNOWN}), as a failure after the replacement is never a plain completion.
     */
    public ExecutionOutcome uploadWithPermission(UploadResult.Published published, PermissionResult permission) {
        Objects.requireNonNull(published, "published");
        Objects.requireNonNull(permission, "permission");
        return switch (permission) {
            case PermissionResult.Applied applied -> published(published);
            case PermissionResult.Unsupported unsupported -> unknown(ExecutionReason.EXIT, List.of(
                "The file is published, but the target cannot set its permission bits; compare the target."));
            case PermissionResult.Refused refused -> unknown(ExecutionReason.EXIT, texts(refused.code(), refused.diagnostic(),
                "The file is published, but its permission bits were refused; compare the target."));
            case PermissionResult.Unconfirmed unconfirmed -> unknown(ExecutionReason.TRANSPORT_LOST, List.of(
                "The file is published, but the connection was lost before the permission bits were confirmed; compare the target."));
            case PermissionResult.NotDispatched notDispatched -> unknown(ExecutionReason.EXIT, List.of(
                "The file is published, but its permission bits were not sent (" + notDispatched.cause() + "); compare the target."));
        };
    }

    private ExecutionOutcome published(UploadResult.Published published) {
        return new ExecutionOutcome(ExecutionReason.EXIT, RemoteState.EXITED, new ExitStatus.Exited(0), SignalDelivery.NOT_SENT, CleanupState.COMPLETE,
            Reconciliation.NOT_REQUIRED, OutputState.NOT_REPORTED, CaptureState.NOT_REPORTED, new TimeoutMs.None(), new StreamCapture.NotCaptured(),
            new StreamCapture.NotCaptured(), new ExecutionFailure.Unclassified(), ResultFlag.OK, List.of("Upload completed"), published.evidence());
    }

    private ExecutionOutcome refusedUpload(UploadResult.Refused refused) {
        Reconciliation reconciliation = refused.cleanup() == CleanupState.COMPLETE ? Reconciliation.NOT_REQUIRED : Reconciliation.REQUIRED;
        List<String> texts = refused.cleanup() == CleanupState.COMPLETE ? texts(refused.code(), refused.diagnostic(), "The target is unchanged.")
            : texts(refused.code(), refused.diagnostic(), "The temporary file could not be confirmed removed; compare the target before sending again.");
        return new ExecutionOutcome(ExecutionReason.EXIT, RemoteState.EXITED, new ExitStatus.Exited(1), SignalDelivery.NOT_SENT, refused.cleanup(), reconciliation,
            OutputState.NOT_REPORTED, CaptureState.NOT_REPORTED, new TimeoutMs.None(), new StreamCapture.NotCaptured(), new StreamCapture.NotCaptured(),
            OPERATION_NOT_STARTED, ResultFlag.FAILED, texts, new CompletionEvidence.NoEvidence());
    }

    private ExecutionOutcome unconfirmed(UnconfirmedCause cause) {
        return switch (cause) {
            case UnconfirmedCause.TransportLost lost -> ExecutionOutcome.transportLost(new ExecutionFailure.Classified(ExecutionStage.SSH_EXECUTION,
                ExecutionErrorCode.SSH_EXECUTION_FAILED, RemoteOutcome.UNKNOWN), List.of("The connection was lost after the first write; the target may or may not hold the file. "
                + "Compare the target before sending again."));
            case UnconfirmedCause.RestoreUnconfirmed restore -> unknown(ExecutionReason.EXIT, List.of(
                "The replacement failed and the original file could not be confirmed back in place; a backup named " + restore.leftoverName() + " may remain."));
            case UnconfirmedCause.DurabilityUnconfirmed durability -> unknown(ExecutionReason.EXIT, List.of(
                "The file is in place, but the flush that makes it durable failed; compare the target."));
            case UnconfirmedCause.CleanupUnconfirmed cleanup -> unknown(ExecutionReason.EXIT, List.of(
                "The temporary file " + cleanup.leftoverName() + " could not be removed; compare the target before sending again."));
        };
    }

    // ---- download ----

    /** The outcome of a download that was read to the end, stored, and whose bytes the use case verified. */
    public ExecutionOutcome downloaded() {
        return new ExecutionOutcome(ExecutionReason.EXIT, RemoteState.EXITED, new ExitStatus.Exited(0), SignalDelivery.NOT_SENT, CleanupState.COMPLETE,
            Reconciliation.NOT_REQUIRED, OutputState.NOT_REPORTED, CaptureState.NOT_REPORTED, new TimeoutMs.None(), new StreamCapture.NotCaptured(),
            new StreamCapture.NotCaptured(), new ExecutionFailure.Unclassified(), ResultFlag.OK, List.of(
                "Server file ready. It has not been saved to your device or delivered to the agent."), new CompletionEvidence.FileRead(true));
    }

    /** The outcome of a download that did not store a file: the target refused, the file is too large, the read failed, or the stored bytes were not verified. */
    public ExecutionOutcome download(DownloadResult result, Duration deadline) {
        Objects.requireNonNull(result, "result");
        Objects.requireNonNull(deadline, "deadline");
        return switch (result) {
            case DownloadResult.Fetched fetched -> throw new IllegalArgumentException("A fetched file is stored and verified before it is an outcome; see downloaded()");
            case DownloadResult.Refused refused -> readOnlyFailure(ExecutionReason.INPUT_FAILED, OPERATION_NOT_STARTED, texts(refused.code(), refused.diagnostic(), "The target is unchanged."));
            case DownloadResult.TooLarge large -> readOnlyFailure(ExecutionReason.INPUT_FAILED, OPERATION_NOT_STARTED, List.of(
                "FILE_TOO_LARGE: The file is larger than a transfer carries. actualBytes=" + large.actualBytes() + " limitBytes=" + large.limitBytes()));
            case DownloadResult.Failed failed -> notDispatched(failed.cause(), deadline);
        };
    }

    /** A download whose stored bytes are not what the adapter confirmed (the digest or the size differs), or whose local storage failed. */
    public ExecutionOutcome downloadNotStored(String code, String sentence) {
        Objects.requireNonNull(code, "code");
        Objects.requireNonNull(sentence, "sentence");
        return readOnlyFailure(ExecutionReason.INPUT_FAILED, OPERATION_NOT_STARTED, List.of(code + ": " + sentence));
    }

    /** A reservation that the budget, the disk or the size limit refused: nothing was sent to the target (D-0012, brief: stage OPERATION, code by refusal, NOT_STARTED). */
    public ExecutionOutcome reservationRefused(ArtifactRefusal refusal) {
        Objects.requireNonNull(refusal, "refusal");
        return switch (refusal.detail()) {
            case ArtifactRefusal.Detail.Budget budget -> readOnlyFailure(ExecutionReason.INPUT_FAILED, new ExecutionFailure.Classified(ExecutionStage.OPERATION,
                ExecutionErrorCode.ARTIFACT_QUOTA, RemoteOutcome.NOT_STARTED), List.of("ARTIFACT_QUOTA: The staging budget cannot take the file. requestedBytes="
                + budget.requestedBytes() + " liveBytes=" + budget.liveBytes() + " holdingBytes=" + budget.holdingBytes() + " budgetBytes=" + budget.budgetBytes()));
            case ArtifactRefusal.Detail.Disk disk -> readOnlyFailure(ExecutionReason.INPUT_FAILED, new ExecutionFailure.Classified(ExecutionStage.OPERATION,
                ExecutionErrorCode.ARTIFACT_STORAGE_FULL, RemoteOutcome.NOT_STARTED), List.of("ARTIFACT_STORAGE_FULL: The disk cannot take the file. requestedBytes="
                + disk.requestedBytes() + " usableBytes=" + disk.usableBytes() + " marginBytes=" + disk.marginBytes()));
            case ArtifactRefusal.Detail.SizeLimit limit -> readOnlyFailure(ExecutionReason.INPUT_FAILED, OPERATION_NOT_STARTED, List.of(
                "FILE_TOO_LARGE: The file is larger than a transfer carries. requestedBytes=" + limit.requestedBytes() + " limitBytes=" + limit.limitBytes()));
        };
    }

    /** The name of the code that a local failure carries, for the one fixed sentence; any other exception is a plain local I/O failure. */
    public ExecutionOutcome localFailure(Throwable cause) {
        Objects.requireNonNull(cause, "cause");
        String code = cause instanceof RequestRefusedException refused ? refused.code().name() : "LOCAL_IO_FAILED";
        return readOnlyFailure(ExecutionReason.INPUT_FAILED, OPERATION_NOT_STARTED, List.of(code + ": A local file of the portal could not be written; nothing on the target changed."));
    }

    // ---- common ----

    /**
     * An operation that did its work and whose result the owner can rely on: the exit is 0 and the evidence is the caller's. The completion still goes through
     * {@link ExecutionOutcome#verdict()}, so an evidence that does not confirm completion gives an unknown result, never a completed one.
     */
    public ExecutionOutcome completed(CompletionEvidence evidence, String text) {
        Objects.requireNonNull(evidence, "evidence");
        Objects.requireNonNull(text, "text");
        return new ExecutionOutcome(ExecutionReason.EXIT, RemoteState.EXITED, new ExitStatus.Exited(0), SignalDelivery.NOT_SENT, CleanupState.COMPLETE,
            Reconciliation.NOT_REQUIRED, OutputState.NOT_REPORTED, CaptureState.NOT_REPORTED, new TimeoutMs.None(), new StreamCapture.NotCaptured(),
            new StreamCapture.NotCaptured(), new ExecutionFailure.Unclassified(), ResultFlag.OK, List.of(text), evidence);
    }

    /**
     * An operation that ended with a failure at a point where the target is known: refused before anything was changed ({@code changedNothing}), or changed and put back.
     * Nothing is left to reconcile.
     */
    public ExecutionOutcome failedAtKnownPoint(boolean changedNothing, String text) {
        Objects.requireNonNull(text, "text");
        if (changedNothing) {
            return readOnlyFailure(ExecutionReason.INPUT_FAILED, OPERATION_NOT_STARTED, List.of(text));
        }
        return new ExecutionOutcome(ExecutionReason.EXIT, RemoteState.EXITED, new ExitStatus.Exited(1), SignalDelivery.NOT_SENT, CleanupState.COMPLETE,
            Reconciliation.NOT_REQUIRED, OutputState.NOT_REPORTED, CaptureState.NOT_REPORTED, new TimeoutMs.None(), new StreamCapture.NotCaptured(),
            new StreamCapture.NotCaptured(), new ExecutionFailure.Classified(ExecutionStage.OPERATION, ExecutionErrorCode.OPERATION_FAILED, RemoteOutcome.COMPLETED),
            ResultFlag.FAILED, List.of(text), new CompletionEvidence.NoEvidence());
    }

    /** The target may or may not have been changed: the owner reconciles it and nothing is sent again by itself. */
    public ExecutionOutcome unknownAfterEffect(String text) {
        Objects.requireNonNull(text, "text");
        return unknown(ExecutionReason.EXIT, List.of(text));
    }

    /** The request never changed the target: the connection, the channel or the SFTP subsystem failed, the time ran out, the owner cancelled, or a local file failed. */
    public ExecutionOutcome notDispatched(TransferFailureCause cause, Duration deadline) {
        return switch (cause) {
            case CONNECT_FAILED -> readOnlyFailure(ExecutionReason.CHANNEL_OPEN_FAILED, new ExecutionFailure.Classified(ExecutionStage.SSH_CONNECT,
                ExecutionErrorCode.SSH_CONNECT_FAILED, RemoteOutcome.NOT_STARTED), List.of("SSH_CONNECT_FAILED: The connection to the target could not be made."));
            case CHANNEL_OPEN_FAILED -> readOnlyFailure(ExecutionReason.CHANNEL_OPEN_FAILED, new ExecutionFailure.Classified(ExecutionStage.SSH_CHANNEL,
                ExecutionErrorCode.SSH_CHANNEL_OPEN_FAILED, RemoteOutcome.NOT_STARTED), List.of("SSH_CHANNEL_OPEN_FAILED: The target did not open the channel."));
            case TRANSPORT_LOST -> readOnlyFailure(ExecutionReason.TRANSPORT_LOST, new ExecutionFailure.Classified(ExecutionStage.SSH_EXECUTION,
                ExecutionErrorCode.SSH_EXECUTION_FAILED, RemoteOutcome.NOT_STARTED), List.of("SSH_EXECUTION_FAILED: The connection was lost before the target was changed."));
            case DEADLINE -> new ExecutionOutcome(ExecutionReason.DEADLINE, RemoteState.NOT_DISPATCHED, new ExitStatus.NoExit(), SignalDelivery.NOT_SENT, CleanupState.COMPLETE,
                Reconciliation.NOT_REQUIRED, OutputState.NOT_REPORTED, CaptureState.NOT_REPORTED, new TimeoutMs.After(Math.max(1L, deadline.toMillis())),
                new StreamCapture.NotCaptured(), new StreamCapture.NotCaptured(), new ExecutionFailure.Unclassified(), ResultFlag.FAILED,
                List.of("The time limit of the transfer was reached before the target was changed."), new CompletionEvidence.NoEvidence());
            case CANCELLED -> readOnlyFailure(ExecutionReason.CANCEL, new ExecutionFailure.Unclassified(), List.of("The transfer was cancelled before the target was changed."));
            case LOCAL_IO_FAILED -> readOnlyFailure(ExecutionReason.INPUT_FAILED, OPERATION_NOT_STARTED, List.of(
                "LOCAL_IO_FAILED: A local file of the portal failed; nothing on the target changed."));
        };
    }

    /** Failed, nothing sent that changes the target, nothing to reconcile, everything the request opened is closed. */
    private ExecutionOutcome readOnlyFailure(ExecutionReason reason, ExecutionFailure failure, List<String> texts) {
        return new ExecutionOutcome(reason, RemoteState.NOT_DISPATCHED, new ExitStatus.NoExit(), SignalDelivery.NOT_SENT, CleanupState.COMPLETE, Reconciliation.NOT_REQUIRED,
            OutputState.NOT_REPORTED, CaptureState.NOT_REPORTED, new TimeoutMs.None(), new StreamCapture.NotCaptured(), new StreamCapture.NotCaptured(), failure,
            ResultFlag.FAILED, texts, new CompletionEvidence.NoEvidence());
    }

    /** The state of the target is not known: the owner reconciles it and nothing is sent again by itself. */
    private ExecutionOutcome unknown(ExecutionReason reason, List<String> texts) {
        return new ExecutionOutcome(reason, RemoteState.UNKNOWN, new ExitStatus.NoExit(), SignalDelivery.NOT_SENT, CleanupState.INCOMPLETE, Reconciliation.REQUIRED,
            OutputState.NOT_REPORTED, CaptureState.NOT_REPORTED, new TimeoutMs.None(), new StreamCapture.NotCaptured(), new StreamCapture.NotCaptured(),
            new ExecutionFailure.Classified(ExecutionStage.OPERATION, ExecutionErrorCode.OPERATION_FAILED, RemoteOutcome.UNKNOWN), ResultFlag.FAILED, texts,
            new CompletionEvidence.NoEvidence());
    }

    private List<String> texts(TransferErrorCode code, FileDiagnostic diagnostic, String closing) {
        String detail = switch (diagnostic) {
            case FileDiagnostic.None none -> "";
            case FileDiagnostic.SftpStatus status -> " sftpStatus=" + status.code();
            case FileDiagnostic.NoSpace noSpace -> " The file system of the target has no space left.";
        };
        return List.of(sentence(code) + detail, closing);
    }

    /** One fixed sentence per code, led by the code's name (2.x {@code fileFailures}). */
    private String sentence(ErrorCode code) {
        if (code instanceof TransferErrorCode transfer) {
            return transfer.name() + ": " + describe(transfer);
        }
        return code.name();
    }

    private String describe(TransferErrorCode code) {
        return switch (code) {
            case PARENT_NOT_FOUND -> "The parent folder on the target does not exist.";
            case FILE_NOT_FOUND -> "The file on the target does not exist.";
            case PERMISSION_DENIED -> "The account has no permission for this file operation. Do not send again before the state of the target is checked.";
            case DESTINATION_EXISTS -> "The target file exists and was not overwritten.";
            case UNSAFE_PATH -> "The path or the kind of file was refused. Use a regular file path without links.";
            case PATH_OUTSIDE_ALLOWED_ROOT -> "The path is outside the allowed root of this target.";
            case PATH_POLICY_UNSUPPORTED -> "The path policy of this target could not be established.";
            case STAGING_UNAVAILABLE -> "A temporary file could not be created next to the target file.";
            case FILE_CHANGED -> "The file differs from the approved content or state.";
            case INVALID_REQUEST -> "The file request is not valid.";
            case WINDOWS_COMMAND_TOO_LARGE -> "The command line for the Windows target is too long.";
            case INSTALL_FAILED -> "The installation failed.";
            case UNTRUSTED_OWNER, MISSING_DACL, UNSAFE_ANCESTOR, UNTRUSTED_WRITER, UNSUPPORTED_ACE, SECURITY_DESCRIPTOR_TOO_LARGE ->
                "The ownership and access checks of the target refused the file (decision D3-02: this version no longer reports this).";
        };
    }
}
