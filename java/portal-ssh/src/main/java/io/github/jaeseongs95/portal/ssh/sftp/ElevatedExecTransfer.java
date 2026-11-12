package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.app.output.StreamFrame;
import io.github.jaeseongs95.portal.app.output.StreamKind;
import io.github.jaeseongs95.portal.app.remote.CommandKind;
import io.github.jaeseongs95.portal.app.remote.DownloadRequest;
import io.github.jaeseongs95.portal.app.remote.DownloadResult;
import io.github.jaeseongs95.portal.app.remote.ElevationPlan;
import io.github.jaeseongs95.portal.app.remote.ElevationRequest;
import io.github.jaeseongs95.portal.app.remote.ElevationResult;
import io.github.jaeseongs95.portal.app.remote.ExecReply;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionLimits;
import io.github.jaeseongs95.portal.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.app.remote.FileDiagnostic;
import io.github.jaeseongs95.portal.app.remote.OutputSink;
import io.github.jaeseongs95.portal.app.remote.PayloadSink;
import io.github.jaeseongs95.portal.app.remote.PayloadSource;
import io.github.jaeseongs95.portal.app.remote.PermissionRequest;
import io.github.jaeseongs95.portal.app.remote.PermissionResult;
import io.github.jaeseongs95.portal.app.remote.PreparedCommand;
import io.github.jaeseongs95.portal.app.remote.RemoteExecution;
import io.github.jaeseongs95.portal.app.remote.RemoteExecutor;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;
import io.github.jaeseongs95.portal.app.remote.ReplaceMethod;
import io.github.jaeseongs95.portal.app.remote.SinkResult;
import io.github.jaeseongs95.portal.app.remote.StdinBytes;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.app.remote.UnconfirmedCause;
import io.github.jaeseongs95.portal.app.remote.UploadRequest;
import io.github.jaeseongs95.portal.app.remote.UploadResult;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import io.github.jaeseongs95.portal.domain.operation.ExitStatus;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.operation.RemoteState;
import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.Arrays;
import java.util.Objects;
import org.springframework.stereotype.Component;
import org.springframework.util.unit.DataSize;

/**
 * File work with elevated rights on a POSIX target, through fixed {@code sudo -n} commands (stage 3 design 6.1, decision D3-11, ruling 11.2): the fallback that
 * serves until the other way, an SFTP server started with {@code sudo -n} and spoken to over MINA, is shown to work on a real server (pilot P3-4, test S3-RO-02). It
 * is not a second implementation of {@link io.github.jaeseongs95.portal.app.remote.RemoteFileTransfer}: a context with two beans of that port would make every
 * consumer choose, so {@link MinaRemoteFileTransfer} is the port and hands the work of an elevated request to this class by the {@link ElevationPlan} of the request.
 *
 * <p>The commands are fixed text. The only things put into them are a path, a digest, a size and a mode, each as a {@link ShellWord} (single quotes, nothing for the
 * shell to expand), and all of them come from values the domain has validated; no command is made of free text. They are external programs on the target ({@code sudo},
 * {@code sh}, {@code cat}, {@code mv}, {@code ln}, {@code rm}, {@code sha256sum}, {@code wc}, {@code stat}, {@code chmod}), and Java cannot replace them because the
 * target is another machine without a JVM: that is the reason for each of them (docs/external-programs).
 *
 * <p>The order of an upload is that of the SFTP path: the probe ({@code sudo -n} must work without a password, else the file work is refused before anything is
 * written); the bytes to a temporary file next to the target ({@code .ssh-approval-<hex>.part}, created with {@code set -C} so that it is a new file, mode 0600); a
 * command that checks the digest and the size of that file on the target and only then puts it in place ({@code mv -f}, or {@code ln} then {@code rm} where the target
 * must not be replaced, which fails when it exists). {@code Published} is the answer only when that last command ended with 0. A step whose end is not seen leaves the
 * result unknown. Where this path differs from SFTP: the owner and group of an overwritten file are those of root's new file ({@code chown} is not part of it), and the
 * whole file is held in memory while it is sent (a command's standard input is a byte array of the port), which the 64 MiB limit bounds.
 */
@Component
public class ElevatedExecTransfer {

    private static final DataSize SMALL_OUTPUT = DataSize.ofKilobytes(64);
    private static final int STAT_NOT_REGULAR = 30;
    private static final int STAT_MISSING = 31;
    private static final int PLACE_CONTENT_DIFFERS = 21;
    private static final int PLACE_EXISTS = 22;
    private static final int PLACE_CLEANUP = 23;
    private static final String SUDO = "sudo -n ";

    /** Writes standard input to a new file (set -C: an existing file is an error) that only the owner may read. */
    private static final String WRITE = SUDO + "sh -c 'umask 077; set -C; cat > \"$1\"' sh ";
    /** Checks the digest and the size of the file, then moves it in place (replace) or links it in place and removes it (fail if it exists). */
    private static final String PLACE = SUDO + "sh -c 'h=$(sha256sum -- \"$1\" | cut -d\" \" -f1); [ \"$h\" = \"$2\" ] || exit 21; "
        + "s=$(wc -c < \"$1\"); [ \"$s\" -eq \"$3\" ] || exit 21; "
        + "if [ \"$5\" = fail ]; then ln -- \"$1\" \"$4\" || exit 22; rm -f -- \"$1\" || exit 23; else mv -f -- \"$1\" \"$4\" || exit 24; fi' sh ";
    private static final String REMOVE = SUDO + "rm -f -- ";
    /** Exit 30: not a regular file or a link; 31: not there; otherwise the size on standard output. */
    private static final String SIZE = SUDO + "sh -c 'if [ -L \"$1\" ]; then exit 30; fi; if [ ! -e \"$1\" ]; then exit 31; fi; if [ ! -f \"$1\" ]; then exit 30; fi; "
        + "wc -c < \"$1\"' sh ";
    private static final String READ = SUDO + "cat -- ";
    private static final String CHMOD = SUDO + "sh -c 'chmod \"$2\" \"$1\" || exit 40; stat -c %a -- \"$1\"' sh ";

    private final ElevationProbe probe;
    private final RemoteExecutor executor;
    private final AtomicReplacer replacer;
    private final Clock clock;

    /**
     * @param probe checks that {@code sudo -n} works and reads why a command did not end
     * @param executor runs the fixed commands; it sends each one at most once
     * @param replacer makes the names of temporary files
     * @param clock the one source of time
     */
    public ElevatedExecTransfer(ElevationProbe probe, RemoteExecutor executor, AtomicReplacer replacer, Clock clock) {
        this.probe = Objects.requireNonNull(probe, "probe");
        this.executor = Objects.requireNonNull(executor, "executor");
        this.replacer = Objects.requireNonNull(replacer, "replacer");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /** What one fixed command came to. */
    private sealed interface Step permits Step.Exited, Step.NotSent, Step.Unknown {
        /** The command ended with an exit code. */
        record Exited(int code) implements Step {
        }

        /** Nothing reached the target. */
        record NotSent(TransferFailureCause cause) implements Step {
        }

        /** The request may have reached the target and its end was not seen. */
        record Unknown() implements Step {
        }
    }

    /** Collects the standard output of a short command, up to a limit. */
    private static final class Collected implements OutputSink {
        private final java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();

        @Override
        public SinkResult accept(StreamFrame frame) {
            if (frame.kind() == StreamKind.STDOUT && bytes.size() < SMALL_OUTPUT.toBytes()) {
                byte[] data = frame.data();
                bytes.write(data, 0, data.length);
            }
            return new SinkResult.Accepted();
        }

        String text() {
            return bytes.toString(StandardCharsets.UTF_8);
        }
    }

    /** Hands the standard output of a long command to the download sink, counting and hashing it. */
    private static final class Forwarded implements OutputSink {
        private final PayloadSink sink;
        private final StreamDigest digest = StreamDigest.sha256();
        private boolean failed;

        Forwarded(PayloadSink sink) {
            this.sink = sink;
        }

        @Override
        public SinkResult accept(StreamFrame frame) {
            if (frame.kind() != StreamKind.STDOUT || failed) {
                return new SinkResult.Accepted();
            }
            byte[] data = frame.data();
            SinkResult result = sink.append(data);
            if (result instanceof SinkResult.Failed) {
                failed = true;
            } else {
                digest.update(data, 0, data.length);
            }
            return result;
        }
    }

    // ---- upload ----

    /**
     * Publishes the bytes with elevated rights.
     *
     * @param request the file to publish
     * @param plan how the target is asked for elevation
     * @param source the bytes
     * @param control the owner's cancel and the check before dispatch
     * @return how the upload ended
     */
    UploadResult upload(UploadRequest request, ElevationPlan.SudoNonInteractive plan, PayloadSource source, ExecutionControl control) {
        if (!(request.path() instanceof PosixRemotePath path) || request.sizeBytes() > request.limits().maxFileSize().toBytes()) {
            return new UploadResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None(), CleanupState.COMPLETE);
        }
        ExecutionLimits limits = limitsOf(request.limits(), SMALL_OUTPUT);
        switch (probe.check(new ElevationRequest(request.target(), plan, limits), control)) {
            case ElevationResult.Granted granted -> {
            }
            case ElevationResult.Denied denied -> {
                return new UploadResult.Refused(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.None(), CleanupState.COMPLETE);
            }
            case ElevationResult.NotApplicable notApplicable -> {
                return new UploadResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None(), CleanupState.COMPLETE);
            }
            case ElevationResult.Unavailable unavailable -> {
                return new UploadResult.NotDispatched(unavailable.cause());
            }
        }
        byte[] bytes;
        try {
            bytes = readAll(source, request.sizeBytes());
        } catch (IOException e) {
            return new UploadResult.NotDispatched(TransferFailureCause.LOCAL_IO_FAILED);
        }
        if (bytes == null || !digestOf(bytes).equals(request.sha256())) {
            return new UploadResult.Refused(TransferErrorCode.FILE_CHANGED, new FileDiagnostic.None(), CleanupState.COMPLETE);
        }
        String tempName = replacer.newTempName();
        String temp = path.sibling(tempName).value();
        Step written = run(request.target(), WRITE + new ShellWord(temp).quoted(), new StdinBytes(bytes), limits, new Collected(), control);
        switch (written) {
            case Step.NotSent notSent -> {
                return new UploadResult.NotDispatched(notSent.cause());
            }
            case Step.Unknown unknown -> {
                return new UploadResult.Unconfirmed(new UnconfirmedCause.TransportLost(), CleanupState.INCOMPLETE);
            }
            case Step.Exited exited -> {
                if (exited.code() != 0) {
                    return cleanedRefusal(request, temp, tempName, TransferErrorCode.STAGING_UNAVAILABLE, limits, control);
                }
            }
        }
        boolean failIfExists = request.overwrite() == OverwriteMode.FAIL_IF_EXISTS;
        String place = PLACE + new ShellWord(temp).quoted() + " " + new ShellWord(request.sha256().hex()).quoted() + " " + new ShellWord(Long.toString(request.sizeBytes())).quoted()
            + " " + new ShellWord(path.value()).quoted() + " " + new ShellWord(failIfExists ? "fail" : "replace").quoted();
        return switch (run(request.target(), place, StdinBytes.none(), limits, new Collected(), control)) {
            case Step.NotSent notSent -> new UploadResult.Unconfirmed(new UnconfirmedCause.TransportLost(), CleanupState.INCOMPLETE);
            case Step.Unknown unknown -> new UploadResult.Unconfirmed(new UnconfirmedCause.TransportLost(), CleanupState.INCOMPLETE);
            case Step.Exited exited -> switch (exited.code()) {
                case 0 -> new UploadResult.Published(request.sha256(), clock.instant(), failIfExists ? ReplaceMethod.NO_CLOBBER_RENAME : ReplaceMethod.POSIX_RENAME);
                case PLACE_CONTENT_DIFFERS -> cleanedRefusal(request, temp, tempName, TransferErrorCode.FILE_CHANGED, limits, control);
                case PLACE_EXISTS -> cleanedRefusal(request, temp, tempName, TransferErrorCode.DESTINATION_EXISTS, limits, control);
                case PLACE_CLEANUP -> new UploadResult.Unconfirmed(new UnconfirmedCause.CleanupUnconfirmed(tempName), CleanupState.INCOMPLETE);
                default -> cleanedRefusal(request, temp, tempName, TransferErrorCode.STAGING_UNAVAILABLE, limits, control);
            };
        };
    }

    private UploadResult cleanedRefusal(UploadRequest request, String temp, String tempName, TransferErrorCode code, ExecutionLimits limits, ExecutionControl control) {
        Step removed = run(request.target(), REMOVE + new ShellWord(temp).quoted(), StdinBytes.none(), limits, new Collected(), control);
        boolean confirmed = removed instanceof Step.Exited exited && exited.code() == 0;
        return confirmed
            ? new UploadResult.Refused(code, new FileDiagnostic.None(), CleanupState.COMPLETE)
            : new UploadResult.Unconfirmed(new UnconfirmedCause.CleanupUnconfirmed(tempName), CleanupState.INCOMPLETE);
    }

    // ---- download ----

    /**
     * Reads a file with elevated rights.
     *
     * @param request the file to read
     * @param plan how the target is asked for elevation
     * @param sink where the bytes go
     * @param control the owner's cancel and the check before dispatch
     * @return how the download ended
     */
    DownloadResult download(DownloadRequest request, ElevationPlan.SudoNonInteractive plan, PayloadSink sink, ExecutionControl control) {
        if (!(request.path() instanceof PosixRemotePath path)) {
            return new DownloadResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None());
        }
        long limit = request.limits().maxFileSize().toBytes();
        ExecutionLimits small = limitsOf(request.limits(), SMALL_OUTPUT);
        switch (probe.check(new ElevationRequest(request.target(), plan, small), control)) {
            case ElevationResult.Granted granted -> {
            }
            case ElevationResult.Denied denied -> {
                return new DownloadResult.Refused(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.None());
            }
            case ElevationResult.NotApplicable notApplicable -> {
                return new DownloadResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None());
            }
            case ElevationResult.Unavailable unavailable -> {
                return new DownloadResult.Failed(unavailable.cause());
            }
        }
        String quotedPath = new ShellWord(path.value()).quoted();
        Collected announcedSize = new Collected();
        Step sized = run(request.target(), SIZE + quotedPath, StdinBytes.none(), small, announcedSize, control);
        if (!(sized instanceof Step.Exited sizeExit)) {
            return new DownloadResult.Failed(sized instanceof Step.NotSent notSent ? notSent.cause() : TransferFailureCause.TRANSPORT_LOST);
        }
        switch (sizeExit.code()) {
            case 0 -> {
            }
            case STAT_MISSING -> {
                return new DownloadResult.Refused(TransferErrorCode.FILE_NOT_FOUND, new FileDiagnostic.None());
            }
            case STAT_NOT_REGULAR -> {
                return new DownloadResult.Refused(TransferErrorCode.UNSAFE_PATH, new FileDiagnostic.None());
            }
            default -> {
                return new DownloadResult.Refused(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.None());
            }
        }
        long size;
        try {
            size = Long.parseLong(announcedSize.text().trim());
        } catch (NumberFormatException e) {
            return new DownloadResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None());
        }
        if (size > limit) {
            return new DownloadResult.TooLarge(size, limit);
        }
        Forwarded forwarded = new Forwarded(sink);
        ExecutionLimits large = limitsOf(request.limits(), DataSize.ofBytes(limit + 1));
        Step read = run(request.target(), READ + quotedPath, StdinBytes.none(), large, forwarded, control);
        if (forwarded.failed) {
            return new DownloadResult.Failed(TransferFailureCause.LOCAL_IO_FAILED);
        }
        if (!(read instanceof Step.Exited readExit)) {
            return new DownloadResult.Failed(read instanceof Step.NotSent notSent ? notSent.cause() : TransferFailureCause.TRANSPORT_LOST);
        }
        if (readExit.code() != 0) {
            return new DownloadResult.Refused(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.None());
        }
        if (forwarded.digest.count() != size) {
            return new DownloadResult.Refused(TransferErrorCode.FILE_CHANGED, new FileDiagnostic.None());
        }
        return new DownloadResult.Fetched(size, forwarded.digest.finishSha256());
    }

    // ---- permissions ----

    /**
     * Sets the permission bits with elevated rights and reads them back.
     *
     * @param request the file and the bits
     * @param plan how the target is asked for elevation
     * @param control the owner's cancel and the check before dispatch
     * @return how the change ended
     */
    PermissionResult applyPermissions(PermissionRequest request, ElevationPlan.SudoNonInteractive plan, ExecutionControl control) {
        if (!(request.path() instanceof PosixRemotePath path)) {
            return new PermissionResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None());
        }
        ExecutionLimits limits = limitsOf(request.limits(), SMALL_OUTPUT);
        switch (probe.check(new ElevationRequest(request.target(), plan, limits), control)) {
            case ElevationResult.Granted granted -> {
            }
            case ElevationResult.Denied denied -> {
                return new PermissionResult.Refused(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.None());
            }
            case ElevationResult.NotApplicable notApplicable -> {
                return new PermissionResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None());
            }
            case ElevationResult.Unavailable unavailable -> {
                return new PermissionResult.NotDispatched(unavailable.cause());
            }
        }
        Collected shown = new Collected();
        Step changed = run(request.target(), CHMOD + new ShellWord(path.value()).quoted() + " " + new ShellWord(request.mode().octal()).quoted(), StdinBytes.none(), limits, shown,
            control);
        return switch (changed) {
            case Step.NotSent notSent -> new PermissionResult.NotDispatched(notSent.cause());
            case Step.Unknown unknown -> new PermissionResult.Unconfirmed(new UnconfirmedCause.TransportLost());
            case Step.Exited exited -> exited.code() == 0 && shown.text().trim().equals(request.mode().octal())
                ? new PermissionResult.Applied()
                : new PermissionResult.Refused(exited.code() == 0 ? TransferErrorCode.INVALID_REQUEST : TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.None());
        };
    }

    // ---- shared parts ----

    private Step run(RemoteTarget target, String commandLine, StdinBytes stdin, ExecutionLimits limits, OutputSink sink, ExecutionControl control) {
        PreparedCommand command = new PreparedCommand(commandLine, stdin, CommandKind.COMMAND);
        ExecutionReport report = executor.run(new RemoteExecution(target, command, limits, ExecReply.NOT_AWAITED), sink, control);
        ExecutionOutcome outcome = report.outcome();
        if (outcome.remoteState() == RemoteState.NOT_DISPATCHED) {
            return new Step.NotSent(probe.causeOf(outcome));
        }
        if (outcome.reason() == ExecutionReason.EXIT && outcome.exit() instanceof ExitStatus.Exited exited) {
            return new Step.Exited(exited.code());
        }
        return new Step.Unknown();
    }

    private static ExecutionLimits limitsOf(TransferLimits limits, DataSize output) {
        return new ExecutionLimits(limits.deadline(), ExecutionLimits.DEFAULT_STOP_GRACE, output);
    }

    /** All the bytes of the artifact, or null when it is not the announced size. */
    private byte[] readAll(PayloadSource source, long announced) throws IOException {
        try (PayloadRead payload = source.open()) {
            if (payload.size() != announced) {
                return null;
            }
            ByteBuffer buffer = ByteBuffer.allocate(Math.toIntExact(announced));
            while (buffer.hasRemaining() && payload.channel().read(buffer) >= 0) {
                // the channel fills the buffer; the loop ends at its end or at the end of the stored file
            }
            return buffer.hasRemaining() ? Arrays.copyOf(buffer.array(), buffer.position()) : buffer.array();
        }
    }

    private Digest digestOf(byte[] bytes) {
        StreamDigest digest = StreamDigest.sha256();
        digest.update(bytes, 0, bytes.length);
        return digest.finishSha256();
    }
}
