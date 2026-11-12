package io.github.jaeseongs95.portal.ssh.cli;

import io.github.jaeseongs95.portal.app.cli.CliVersion;
import io.github.jaeseongs95.portal.app.cli.RemoteState;
import io.github.jaeseongs95.portal.app.cli.RemoteStatus;
import io.github.jaeseongs95.portal.app.output.StreamFrame;
import io.github.jaeseongs95.portal.app.output.StreamKind;
import io.github.jaeseongs95.portal.app.remote.AgentCliInstallRequest;
import io.github.jaeseongs95.portal.app.remote.AgentCliInstallResult;
import io.github.jaeseongs95.portal.app.remote.AgentCliInstallerPort;
import io.github.jaeseongs95.portal.app.remote.AgentCliPlan;
import io.github.jaeseongs95.portal.app.remote.AgentCliRefusal;
import io.github.jaeseongs95.portal.app.remote.AgentCliStatusRequest;
import io.github.jaeseongs95.portal.app.remote.AgentCliStatusResult;
import io.github.jaeseongs95.portal.app.remote.CommandKind;
import io.github.jaeseongs95.portal.app.remote.ExecReply;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionLimits;
import io.github.jaeseongs95.portal.app.remote.FileAccess;
import io.github.jaeseongs95.portal.app.remote.LoginState;
import io.github.jaeseongs95.portal.app.remote.OutputSink;
import io.github.jaeseongs95.portal.app.remote.PathPolicyBinding;
import io.github.jaeseongs95.portal.app.remote.PreparedCommand;
import io.github.jaeseongs95.portal.app.remote.RemoteExecution;
import io.github.jaeseongs95.portal.app.remote.RemoteExecutor;
import io.github.jaeseongs95.portal.app.remote.RemoteFileTransfer;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;
import io.github.jaeseongs95.portal.app.remote.RestoreEvidence;
import io.github.jaeseongs95.portal.app.remote.SinkResult;
import io.github.jaeseongs95.portal.app.remote.StdinBytes;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.app.remote.UnconfirmedCause;
import io.github.jaeseongs95.portal.app.remote.UploadRequest;
import io.github.jaeseongs95.portal.app.remote.UploadResult;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProviderId;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import io.github.jaeseongs95.portal.domain.operation.ExitStatus;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import io.github.jaeseongs95.portal.ssh.platform.AgentCliLayout;
import io.github.jaeseongs95.portal.ssh.platform.AgentCliStep;
import io.github.jaeseongs95.portal.ssh.sftp.SessionAcquisition;
import io.github.jaeseongs95.portal.ssh.sftp.SessionLease;
import io.github.jaeseongs95.portal.ssh.sftp.SessionSource;
import io.github.jaeseongs95.portal.ssh.sftp.SftpChannels;
import io.github.jaeseongs95.portal.ssh.sftp.StreamDigest;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.apache.sshd.sftp.client.SftpClient;
import org.apache.sshd.sftp.common.SftpConstants;
import org.apache.sshd.sftp.common.SftpException;
import org.springframework.stereotype.Component;
import org.springframework.util.unit.DataSize;

/**
 * Installs an agent CLI on a target and reads its state (stage 3 design 6.2, decision Q3). The order is the one that makes the result honest (defect D-0035):
 * <ol>
 *   <li>this server checks the SHA-512 integrity of the package against the release the owner approved, before anything is sent: a package that does not match is
 *       {@code Refused(PACKAGE_INTEGRITY_MISMATCH)} and the target is never contacted;</li>
 *   <li>read-only fixed commands say where the package goes, where the release will live and what {@code current} points to now; a release that is already current is
 *       {@code Reused} and nothing is written;</li>
 *   <li>the package goes to {@code .partial/package.tgz} over SFTP (the file transfer port: temporary file, digest check, atomic put in place);</li>
 *   <li>fixed commands unpack it and read the version out of its metadata file (no installed program is run), keep where {@code current} points, and switch it;</li>
 *   <li>the switch is read back (where {@code current} points, and the version of what it points to). Only then is the answer {@code Installed}. When the read-back
 *       fails, {@code current} is put back to what it was; the answer is {@code RolledBack} when that is read back, {@code Unconfirmed} when it is not.</li>
 * </ol>
 * There is no receipt file on the target: the operation journal is the one record, and a path that returns {@code Installed} without the read-back does not exist. A step
 * whose end is not seen is {@code Unconfirmed}; no command is sent twice. The status is read over SFTP ({@code readlink} of {@code current}, the existence of the tool's
 * credential file); the tool itself is never run to ask (2.x ran it).
 *
 * <p>The fixed commands are made by the target platform and are programs of the target ({@code sh} and {@code tar}, or PowerShell and {@code tar.exe}): Java cannot replace
 * them because the target is another machine without a JVM (docs/external-programs). This class sends nothing but them and holds no text of a caller. Whether the target
 * needs {@code npm} or {@code node} to run the tool after the package is unpacked is not known; the real-server tests (S3-RO-06, pilot P3-6) show it.
 */
@Component
public class AgentCliInstaller implements AgentCliInstallerPort {

    private static final DataSize SMALL_OUTPUT = DataSize.ofKilobytes(64);
    private static final Duration ONE_MILLISECOND = Duration.ofMillis(1);
    private static final int BLOCK_BYTES = 64 * 1024;
    private static final Pattern VERSION_DIRECTORY = Pattern.compile("(\\d{1,6}\\.\\d{1,6}\\.\\d{1,6})-[0-9a-f]{16}");
    private static final Pattern PATH_SEPARATOR = Pattern.compile("[\\\\/]");
    /** The file each tool keeps its login in, under the home directory; only its existence is looked at. */
    private static final Map<AgentCliProviderId, String> CREDENTIAL_FILES = Map.of(AgentCliProviderId.CODEX, ".codex/auth.json", AgentCliProviderId.CLAUDE,
        ".claude/.credentials.json");

    private final RemoteExecutor executor;
    private final RemoteFileTransfer transfer;
    private final SessionSource sessions;
    private final SftpChannels channels;
    private final Clock clock;

    /**
     * @param executor runs the fixed commands; it sends each at most once
     * @param transfer puts the package on the target
     * @param sessions leases a session for the status read
     * @param channels opens the SFTP channel of that session
     * @param clock the one source of time
     */
    public AgentCliInstaller(RemoteExecutor executor, RemoteFileTransfer transfer, SessionSource sessions, SftpChannels channels, Clock clock) {
        this.executor = Objects.requireNonNull(executor, "executor");
        this.transfer = Objects.requireNonNull(transfer, "transfer");
        this.sessions = Objects.requireNonNull(sessions, "sessions");
        this.channels = Objects.requireNonNull(channels, "channels");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /** What one fixed command came to. */
    private sealed interface Run permits Run.Exited, Run.NotSent, Run.Unknown {
        record Exited(int code, String stdout) implements Run {
            String line() {
                return stdout.strip();
            }
        }

        /** Nothing reached the target. */
        record NotSent(TransferFailureCause cause) implements Run {
        }

        /** The request may have reached the target and its end was not seen. */
        record Unknown(TransferFailureCause cause) implements Run {
        }
    }

    /** The size and the two digests of the package, measured in one pass. */
    private record Measured(String integrity, Digest sha256, long size) {
    }

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

    // ---- install ----

    @Override
    public AgentCliInstallResult install(AgentCliInstallRequest request, ExecutionControl control) {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(control, "control");
        AgentCliPlan plan = request.plan();
        AgentRelease release = plan.release();
        Instant end = clock.instant().plus(request.limits().deadline());
        Measured measured;
        try {
            measured = measure(request.tarball().open());
        } catch (IOException e) {
            return new AgentCliInstallResult.NotDispatched(TransferFailureCause.LOCAL_IO_FAILED);
        }
        if (!measured.integrity().equals(release.integrity())) {
            return new AgentCliInstallResult.Refused(AgentCliRefusal.PACKAGE_INTEGRITY_MISMATCH);
        }
        RemoteTarget target = request.target();

        Run tarballRun = run(plan, AgentCliStep.TARBALL_PATH, target, request.limits(), end, control);
        Run finalRun = run(plan, AgentCliStep.FINAL_PATH, target, request.limits(), end, control);
        Run beforeRun = run(plan, AgentCliStep.CURRENT_BEFORE, target, request.limits(), end, control);
        Optional<AgentCliInstallResult> notRead = firstFailure(tarballRun, finalRun, beforeRun);
        if (notRead.isPresent()) {
            return notRead.orElseThrow();
        }
        String tarballPath = ((Run.Exited) tarballRun).line();
        String finalPath = ((Run.Exited) finalRun).line();
        String previous = ((Run.Exited) beforeRun).line();
        CliVersion version = new CliVersion(release.version());
        if (!previous.isEmpty() && previous.equals(finalPath)) {
            return new AgentCliInstallResult.Reused(version);
        }
        RemotePath path;
        try {
            path = RemotePath.parse(tarballPath);
        } catch (IllegalArgumentException e) {
            return new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED);
        }
        Optional<AgentCliInstallResult> early = stopBefore(plan, target, request.limits(), end, control);
        if (early.isPresent()) {
            return early.orElseThrow();
        }

        if (!(run(plan, AgentCliStep.PREPARE, target, request.limits(), end, control) instanceof Run.Exited prepared) || prepared.code() != 0) {
            return abort(plan, target, request.limits(), control, new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
        }
        UploadRequest upload = new UploadRequest(target, path, measured.size(), measured.sha256(), OverwriteMode.REPLACE, new FileAccess.Direct(),
            new PathPolicyBinding.NoRootPolicy(), new TransferLimits(remaining(end), request.limits().maxFileSize()));
        UploadResult uploaded = transfer.upload(upload, request.tarball(), control);
        switch (uploaded) {
            case UploadResult.Published published -> {
            }
            case UploadResult.NotDispatched notDispatched -> {
                return abort(plan, target, request.limits(), control, new AgentCliInstallResult.NotDispatched(notDispatched.cause()));
            }
            case UploadResult.Refused refused -> {
                return abort(plan, target, request.limits(), control, new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
            }
            case UploadResult.RolledBack rolledBack -> {
                return abort(plan, target, request.limits(), control, new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
            }
            case UploadResult.Unconfirmed unconfirmed -> {
                return new AgentCliInstallResult.Unconfirmed(unconfirmed.cause(), 0);
            }
        }
        early = stopBefore(plan, target, request.limits(), end, control);
        if (early.isPresent()) {
            return early.orElseThrow();
        }

        Run unpacked = run(plan, AgentCliStep.UNPACK, target, request.limits(), end, control);
        if (!(unpacked instanceof Run.Exited unpackedExit)) {
            return unknownOrNotSent(unpacked);
        }
        if (unpackedExit.code() != 0) {
            AgentCliRefusal reason = unpackedExit.code() == 127 ? AgentCliRefusal.PREREQUISITE_MISSING : AgentCliRefusal.INSTALL_COMMAND_FAILED;
            return abort(plan, target, request.limits(), control, new AgentCliInstallResult.Refused(reason));
        }
        Run read = run(plan, AgentCliStep.VERSION, target, request.limits(), end, control);
        if (!(read instanceof Run.Exited versionExit)) {
            return unknownOrNotSent(read);
        }
        if (versionExit.code() != 0 || !versionExit.line().equals(release.version())) {
            return abort(plan, target, request.limits(), control, new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
        }
        early = stopBefore(plan, target, request.limits(), end, control);
        if (early.isPresent()) {
            return early.orElseThrow();
        }
        if (!(run(plan, AgentCliStep.KEEP_PREVIOUS, target, request.limits(), end, control) instanceof Run.Exited kept) || kept.code() != 0) {
            return abort(plan, target, request.limits(), control, new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
        }
        return switchAndConfirm(plan, target, request.limits(), control, finalPath, previous, version);
    }

    /**
     * The switch and what follows it: from here the target may have changed, so every failure is either undone and confirmed undone, or unknown. No deadline stops these
     * steps (a cancel is a request; half a switch is worse than a late one), each has the time limit of the request of its own.
     */
    private AgentCliInstallResult switchAndConfirm(AgentCliPlan plan, RemoteTarget target, TransferLimits limits, ExecutionControl control, String finalPath, String previous,
                                                   CliVersion version) {
        Instant never = clock.instant().plus(limits.deadline());
        Run switched = run(plan, AgentCliStep.SWITCH, target, limits, never, control);
        Run after = run(plan, AgentCliStep.CURRENT_AFTER, target, limits, never, control);
        if (!(after instanceof Run.Exited afterExit) || afterExit.code() != 0) {
            return new AgentCliInstallResult.Unconfirmed(new UnconfirmedCause.TransportLost(), 0);
        }
        boolean pointsToNew = afterExit.line().equals(finalPath);
        boolean switchedOk = switched instanceof Run.Exited switchExit && switchExit.code() == 0;
        if (!pointsToNew && afterExit.line().equals(previous) && !switchedOk) {
            // The switch did not happen and nothing changed: the old version is still current.
            return abort(plan, target, limits, control, new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
        }
        if (pointsToNew) {
            Run confirm = run(plan, AgentCliStep.VERSION, target, limits, never, control);
            if (confirm instanceof Run.Exited confirmExit && confirmExit.code() == 0 && confirmExit.line().equals(version.value())) {
                return finish(plan, target, limits, control, version);
            }
            if (!(confirm instanceof Run.Exited)) {
                return new AgentCliInstallResult.Unconfirmed(new UnconfirmedCause.TransportLost(), 0);
            }
        }
        return rollBack(plan, target, limits, control, previous);
    }

    private AgentCliInstallResult finish(AgentCliPlan plan, RemoteTarget target, TransferLimits limits, ExecutionControl control, CliVersion version) {
        Instant never = clock.instant().plus(limits.deadline());
        int failures = 0;
        failures += failed(run(plan, AgentCliStep.DROP_PREVIOUS, target, limits, never, control));
        failures += failed(run(plan, AgentCliStep.CLEANUP, target, limits, never, control));
        return new AgentCliInstallResult.Installed(version, failures, clock.instant());
    }

    private AgentCliInstallResult rollBack(AgentCliPlan plan, RemoteTarget target, TransferLimits limits, ExecutionControl control, String previous) {
        Instant never = clock.instant().plus(limits.deadline());
        run(plan, previous.isEmpty() ? AgentCliStep.ROLLBACK_NONE : AgentCliStep.ROLLBACK, target, limits, never, control);
        Run back = run(plan, AgentCliStep.CURRENT_AFTER, target, limits, never, control);
        boolean restored = back instanceof Run.Exited backExit && backExit.code() == 0 && backExit.line().equals(previous);
        int failures = failed(run(plan, AgentCliStep.CLEANUP, target, limits, never, control));
        if (restored) {
            return new AgentCliInstallResult.RolledBack(AgentCliRefusal.INSTALL_COMMAND_FAILED, new RestoreEvidence(clock.instant()), failures);
        }
        return new AgentCliInstallResult.Unconfirmed(new UnconfirmedCause.RestoreUnconfirmed("current"), failures);
    }

    // ---- shared parts ----

    private Run run(AgentCliPlan plan, AgentCliStep step, RemoteTarget target, TransferLimits limits, Instant end, ExecutionControl control) {
        PreparedCommand command = new PreparedCommand(step.in(plan).commandLine(), StdinBytes.none(), CommandKind.COMMAND);
        ExecutionLimits executionLimits = new ExecutionLimits(remaining(end), ExecutionLimits.DEFAULT_STOP_GRACE, SMALL_OUTPUT);
        Collected output = new Collected();
        ExecutionOutcome outcome = executor.run(new RemoteExecution(target, command, executionLimits, ExecReply.NOT_AWAITED), output, control).outcome();
        if (outcome.reason() == ExecutionReason.EXIT && outcome.exit() instanceof ExitStatus.Exited exited
            && outcome.failure().code() != ExecutionErrorCode.SSH_CONNECT_FAILED) {
            return new Run.Exited(exited.code(), output.text());
        }
        TransferFailureCause cause = causeOf(outcome);
        return outcome.remoteState() == io.github.jaeseongs95.portal.domain.operation.RemoteState.NOT_DISPATCHED ? new Run.NotSent(cause) : new Run.Unknown(cause);
    }

    private TransferFailureCause causeOf(ExecutionOutcome outcome) {
        if (outcome.failure().code() == ExecutionErrorCode.SSH_CONNECT_FAILED) {
            return TransferFailureCause.CONNECT_FAILED;
        }
        return switch (outcome.reason()) {
            case EXIT, TRANSPORT_LOST -> TransferFailureCause.TRANSPORT_LOST;
            case DEADLINE -> TransferFailureCause.DEADLINE;
            case CANCEL -> TransferFailureCause.CANCELLED;
            case CHANNEL_OPEN_FAILED -> TransferFailureCause.CHANNEL_OPEN_FAILED;
            case INPUT_FAILED -> TransferFailureCause.LOCAL_IO_FAILED;
        };
    }

    private Duration remaining(Instant end) {
        Duration left = Duration.between(clock.instant(), end);
        return left.compareTo(ONE_MILLISECOND) < 0 ? ONE_MILLISECOND : left;
    }

    /** The result for a read-only step that did not give an answer: nothing was changed, so it is a failure to start, not an unknown outcome. */
    private Optional<AgentCliInstallResult> firstFailure(Run... runs) {
        for (Run run : runs) {
            switch (run) {
                case Run.Exited exited -> {
                    if (exited.code() != 0) {
                        return Optional.of(new AgentCliInstallResult.Refused(AgentCliRefusal.PREREQUISITE_MISSING));
                    }
                }
                case Run.NotSent notSent -> {
                    return Optional.of(new AgentCliInstallResult.NotDispatched(notSent.cause()));
                }
                case Run.Unknown unknown -> {
                    return Optional.of(new AgentCliInstallResult.NotDispatched(unknown.cause()));
                }
            }
        }
        return Optional.empty();
    }

    private AgentCliInstallResult unknownOrNotSent(Run run) {
        return switch (run) {
            case Run.NotSent notSent -> new AgentCliInstallResult.NotDispatched(notSent.cause());
            case Run.Unknown unknown -> new AgentCliInstallResult.Unconfirmed(new UnconfirmedCause.TransportLost(), 0);
            case Run.Exited exited -> new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED);
        };
    }

    /** A cancel or the time limit before the switch: the partial directory is removed and the answer says whether that is confirmed. */
    private Optional<AgentCliInstallResult> stopBefore(AgentCliPlan plan, RemoteTarget target, TransferLimits limits, Instant end, ExecutionControl control) {
        TransferFailureCause cause;
        if (control.cancel().requested()) {
            cause = TransferFailureCause.CANCELLED;
        } else if (!clock.instant().isBefore(end)) {
            cause = TransferFailureCause.DEADLINE;
        } else {
            return Optional.empty();
        }
        return Optional.of(abort(plan, target, limits, control, new AgentCliInstallResult.NotDispatched(cause)));
    }

    /** Ends the installation before the switch: removes the partial directory and returns {@code result}, or {@code Unconfirmed} when the removal is not confirmed. */
    private AgentCliInstallResult abort(AgentCliPlan plan, RemoteTarget target, TransferLimits limits, ExecutionControl control, AgentCliInstallResult result) {
        Instant never = clock.instant().plus(limits.deadline());
        Run cleaned = run(plan, AgentCliStep.CLEANUP, target, limits, never, control);
        if (cleaned instanceof Run.Exited exited && exited.code() == 0) {
            return result;
        }
        String leftover = new AgentCliLayout(plan.provider(), plan.release()).versionDirectory() + ".partial";
        return new AgentCliInstallResult.Unconfirmed(new UnconfirmedCause.CleanupUnconfirmed(leftover), 1);
    }

    private int failed(Run run) {
        return run instanceof Run.Exited exited && exited.code() == 0 ? 0 : 1;
    }

    /** Reads the package once: its SHA-512 in the form of an npm {@code integrity} value, its SHA-256 and its size. */
    private Measured measure(PayloadRead payload) throws IOException {
        StreamDigest sha512 = StreamDigest.sha512();
        StreamDigest sha256 = StreamDigest.sha256();
        byte[] block = new byte[BLOCK_BYTES];
        ByteBuffer buffer = ByteBuffer.wrap(block);
        try (payload) {
            int read;
            while (true) {
                buffer.clear();
                read = payload.channel().read(buffer);
                if (read < 0) {
                    break;
                }
                sha512.update(block, 0, read);
                sha256.update(block, 0, read);
            }
        }
        long size = sha256.count();
        return new Measured("sha512-" + Base64.getEncoder().encodeToString(sha512.finish()), sha256.finishSha256(), size);
    }

    // ---- status ----

    @Override
    public AgentCliStatusResult status(AgentCliStatusRequest request, ExecutionControl control) {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(control, "control");
        return switch (sessions.lease(request.target(), control.cancel())) {
            case SessionAcquisition.Unavailable unavailable -> new AgentCliStatusResult.Failed(unavailable.cause());
            case SessionAcquisition.Acquired acquired -> statusOver(acquired.lease(), request, control);
        };
    }

    private AgentCliStatusResult statusOver(SessionLease lease, AgentCliStatusRequest request, ExecutionControl control) {
        try (lease) {
            control.guard().beforeDispatch();
            SftpClient client;
            try {
                client = channels.open(lease.session());
            } catch (IOException e) {
                boolean alive = lease.session().isOpen();
                if (!alive) {
                    lease.discard();
                }
                return new AgentCliStatusResult.Failed(alive ? TransferFailureCause.CHANNEL_OPEN_FAILED : TransferFailureCause.TRANSPORT_LOST);
            }
            try {
                return observe(client, request);
            } catch (IOException e) {
                lease.discard();
                return new AgentCliStatusResult.Failed(TransferFailureCause.TRANSPORT_LOST);
            } finally {
                try {
                    client.close();
                } catch (IOException e) {
                    // the channel is closed with its session; nothing is left to do
                }
            }
        }
    }

    /** What the target shows, from the link {@code current} and the credential file of the tool. */
    private AgentCliStatusResult observe(SftpClient client, AgentCliStatusRequest request) throws IOException {
        String home = client.canonicalPath(".");
        String base = home.endsWith("/") ? home : home + "/";
        String link = base + AgentCliLayout.providerRoot(request.provider()) + "/current";
        String pointsTo;
        try {
            pointsTo = client.readLink(link);
        } catch (SftpException e) {
            if (e.getStatus() != SftpConstants.SSH_FX_NO_SUCH_FILE && e.getStatus() != SftpConstants.SSH_FX_NO_SUCH_PATH) {
                throw e;
            }
            return new AgentCliStatusResult.Observed(new RemoteStatus.NotFound(), revisionOf("none"), LoginState.NOT_INSTALLED);
        }
        String[] parts = PATH_SEPARATOR.split(pointsTo.strip());
        Matcher directory = VERSION_DIRECTORY.matcher(parts[parts.length - 1]);
        if (!directory.matches()) {
            return new AgentCliStatusResult.Observed(new RemoteStatus.NotFound(), revisionOf(pointsTo), LoginState.NOT_INSTALLED);
        }
        RemoteStatus remote = new RemoteStatus.Known(RemoteState.COMPLETED, new CliVersion(directory.group(1)), 0);
        return new AgentCliStatusResult.Observed(remote, revisionOf(pointsTo), loginOf(client, base, request.provider()));
    }

    private LoginState loginOf(SftpClient client, String base, AgentCliProviderId provider) throws IOException {
        try {
            client.stat(base + CREDENTIAL_FILES.get(provider));
            return LoginState.SIGNED_IN;
        } catch (SftpException e) {
            if (e.getStatus() == SftpConstants.SSH_FX_NO_SUCH_FILE || e.getStatus() == SftpConstants.SSH_FX_NO_SUCH_PATH) {
                return LoginState.SIGNED_OUT;
            }
            throw e;
        }
    }

    /** The digest of the installation as seen: of where {@code current} points, so a change of version is a change of revision. */
    private Digest revisionOf(String seen) {
        StreamDigest digest = StreamDigest.sha256();
        byte[] bytes = ("agent-cli-installation:" + seen).getBytes(StandardCharsets.UTF_8);
        digest.update(bytes, 0, bytes.length);
        return digest.finishSha256();
    }
}
