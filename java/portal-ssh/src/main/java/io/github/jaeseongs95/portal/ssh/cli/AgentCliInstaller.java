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
import java.io.InputStream;
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
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.util.unit.DataSize;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Installs an agent CLI on a target and reads its state (stage 3 design 6.2, decision Q3, ruling of the review of external programs). It works over SFTP and in Java; the
 * one command it runs on the target is the unpacking of the package ({@link AgentCliStep#UNPACK}). The order is the one that makes the result honest (defect D-0035):
 * <ol>
 *   <li>this server checks the SHA-512 integrity of the package against the release the owner approved, before anything is sent: a package that does not match is
 *       {@code Refused(PACKAGE_INTEGRITY_MISMATCH)} and the target is never contacted;</li>
 *   <li>over SFTP: the home directory, the directory of the release, and {@link CurrentLink} (the release now in use). A release that is already current is
 *       {@code Reused} and nothing is written;</li>
 *   <li>the package goes to {@code .partial/package.tgz} (the file transfer port: temporary file, digest check, atomic put in place);</li>
 *   <li>the unpack command runs; the version is read from {@code package/package.json} over SFTP and parsed with Jackson, the partial directory is renamed to the release
 *       directory;</li>
 *   <li>{@code current} is switched, read back, and the version of what it points to is read again. Only then is the answer {@code Installed}. When the read-back fails,
 *       {@code current} is put back to what it was; the answer is {@code RolledBack} when that is read back, {@code Unconfirmed} when it is not.</li>
 * </ol>
 * There is no receipt file on the target: the operation journal is the one record, and a path that returns {@code Installed} without the read-back does not exist. A
 * step whose end is not seen is {@code Unconfirmed}; nothing is sent twice. The status is read over SFTP too (the link, the existence of the tool's credential file);
 * the tool itself is never run to ask (2.x ran it).
 *
 * <p>Why {@code tar} stays a command of the target: it unpacks the whole archive at once and keeps the modes of its files, where Java would put thousands of files one by
 * one over SFTP; {@code tar} (Windows: {@code tar.exe}) is an external program of the target and Java cannot replace it there, because the target is another machine
 * without a JVM (docs/external-programs). Whether the target needs {@code npm} or {@code node} to run the tool after the package is unpacked is not known; the
 * real-server tests (S3-RO-06, pilot P3-6) show it.
 */
@Component
public class AgentCliInstaller implements AgentCliInstallerPort {

    private static final Logger LOG = LoggerFactory.getLogger(AgentCliInstaller.class);
    /** How much of the end of a command's standard error a log line keeps. */
    private static final int DIAGNOSTIC_CHARACTERS = 2048;
    private static final DataSize SMALL_OUTPUT = DataSize.ofKilobytes(64);
    private static final Duration ONE_MILLISECOND = Duration.ofMillis(1);
    private static final int BLOCK_BYTES = 64 * 1024;
    /** The metadata file of a package is small; a larger one is not read. */
    private static final int METADATA_LIMIT = 1024 * 1024;
    private static final int TAR_NOT_FOUND = 127;
    private static final Pattern VERSION_DIRECTORY = Pattern.compile("(\\d{1,6}\\.\\d{1,6}\\.\\d{1,6})-[0-9a-f]{16}");
    private static final Pattern DRIVE_PATH = Pattern.compile("/[A-Za-z]:/.*");
    /** The file each tool keeps its login in, under the home directory; only its existence is looked at. */
    private static final Map<AgentCliProviderId, String> CREDENTIAL_FILES = Map.of(AgentCliProviderId.CODEX, ".codex/auth.json", AgentCliProviderId.CLAUDE,
        ".claude/.credentials.json");

    private final RemoteExecutor executor;
    private final RemoteFileTransfer transfer;
    private final SessionSource sessions;
    private final SftpChannels channels;
    private final JsonMapper json;
    private final Clock clock;

    /**
     * @param executor runs the unpack command; it sends it at most once
     * @param transfer puts the package on the target
     * @param sessions leases the session the SFTP work runs on
     * @param channels opens the SFTP channel of that session
     * @param json reads the metadata file of the package
     * @param clock the one source of time
     */
    public AgentCliInstaller(RemoteExecutor executor, RemoteFileTransfer transfer, SessionSource sessions, SftpChannels channels, JsonMapper json, Clock clock) {
        this.executor = Objects.requireNonNull(executor, "executor");
        this.transfer = Objects.requireNonNull(transfer, "transfer");
        this.sessions = Objects.requireNonNull(sessions, "sessions");
        this.channels = Objects.requireNonNull(channels, "channels");
        this.json = Objects.requireNonNull(json, "json");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /** The size and the two digests of the package, measured in one pass. */
    private record Measured(String integrity, Digest sha256, long size) {
    }

    private static final class Collected implements OutputSink {
        private final java.io.ByteArrayOutputStream errors = new java.io.ByteArrayOutputStream();

        @Override
        public SinkResult accept(StreamFrame frame) {
            if (frame.kind() == StreamKind.STDERR && errors.size() < SMALL_OUTPUT.toBytes()) {
                byte[] data = frame.data();
                errors.write(data, 0, data.length);
            }
            return new SinkResult.Accepted();
        }

        /** The end of what the command wrote to its standard error, at most {@link #DIAGNOSTIC_CHARACTERS} characters: the unpack command prints no secret. */
        String errorTail() {
            String text = errors.toString(StandardCharsets.UTF_8).strip();
            return text.length() <= DIAGNOSTIC_CHARACTERS ? text : text.substring(text.length() - DIAGNOSTIC_CHARACTERS);
        }
    }

    // ---- install ----

    @Override
    public AgentCliInstallResult install(AgentCliInstallRequest request, ExecutionControl control) {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(control, "control");
        AgentRelease release = request.plan().release();
        Measured measured;
        try {
            measured = measure(request.tarball().open());
        } catch (IOException e) {
            return new AgentCliInstallResult.NotDispatched(TransferFailureCause.LOCAL_IO_FAILED);
        }
        if (!measured.integrity().equals(release.integrity())) {
            return new AgentCliInstallResult.Refused(AgentCliRefusal.PACKAGE_INTEGRITY_MISMATCH);
        }
        return switch (sessions.lease(request.target(), control.cancel())) {
            case SessionAcquisition.Unavailable unavailable -> new AgentCliInstallResult.NotDispatched(unavailable.cause());
            case SessionAcquisition.Acquired acquired -> installOver(acquired.lease(), request, control, measured);
        };
    }

    private AgentCliInstallResult installOver(SessionLease lease, AgentCliInstallRequest request, ExecutionControl control, Measured measured) {
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
                return new AgentCliInstallResult.NotDispatched(alive ? TransferFailureCause.CHANNEL_OPEN_FAILED : TransferFailureCause.TRANSPORT_LOST);
            }
            try {
                return new Installation(lease, client, request, control, measured).run();
            } catch (IOException e) {
                lease.discard();
                LOG.warn("The connection failed while the agent CLI was installed", e);
                return new AgentCliInstallResult.NotDispatched(TransferFailureCause.TRANSPORT_LOST);
            } finally {
                closeQuietly(client);
            }
        }
    }

    /** One installation: its state (the paths on the target, how many removals failed) and its steps. */
    private final class Installation {
        private final SessionLease lease;
        private final SftpClient client;
        private final AgentCliInstallRequest request;
        private final AgentCliPlan plan;
        private final AgentRelease release;
        private final AgentCliLayout layout;
        private final ExecutionControl control;
        private final Measured measured;
        private final Instant end;
        private String base = "";
        private String partial = "";
        private String finalDirectory = "";
        private CurrentLink current;
        private int failures;

        Installation(SessionLease lease, SftpClient client, AgentCliInstallRequest request, ExecutionControl control, Measured measured) {
            this.lease = lease;
            this.client = client;
            this.request = request;
            this.plan = request.plan();
            this.release = plan.release();
            this.layout = new AgentCliLayout(plan.provider(), release);
            this.control = control;
            this.measured = measured;
            this.end = clock.instant().plus(request.limits().deadline());
        }

        AgentCliInstallResult run() throws IOException {
            String home = client.canonicalPath(".");
            base = home.endsWith("/") ? home : home + "/";
            partial = base + layout.partialDirectory();
            finalDirectory = base + layout.finalDirectory();
            current = new CurrentLink(client, base + layout.providerRoot());
            String previous = current.read();
            String name = layout.versionDirectory();
            if (previous.equals(name)) {
                return new AgentCliInstallResult.Reused(new CliVersion(release.version()));
            }
            Optional<AgentCliInstallResult> early = stopBefore();
            if (early.isPresent()) {
                return early.orElseThrow();
            }
            try {
                makeDirectories(partial);
            } catch (IOException e) {
                return failedBeforeUpload(e);
            }
            AgentCliInstallResult uploaded = upload();
            if (uploaded != null) {
                return uploaded;
            }
            early = stopBefore();
            if (early.isPresent()) {
                return early.orElseThrow();
            }
            AgentCliInstallResult unpacked = unpack();
            if (unpacked != null) {
                return unpacked;
            }
            try {
                remove(partial + "/package.tgz");
                String version = packageVersion(partial + "/package/package.json");
                if (!version.equals(release.version())) {
                    LOG.warn("The unpacked package says version [{}], the release is {}", version, release.version());
                    return abort(new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
                }
                early = stopBefore();
                if (early.isPresent()) {
                    return early.orElseThrow();
                }
                if (removeTree(finalDirectory) > 0) {
                    return abort(new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
                }
                client.rename(partial, finalDirectory);
            } catch (IOException e) {
                return failedBeforeSwitch(e);
            }
            return switchAndConfirm(previous, name);
        }

        /** The upload of the package; null when it is on the target. */
        private AgentCliInstallResult upload() {
            RemotePath path = remotePath(partial + "/package.tgz");
            UploadRequest upload = new UploadRequest(request.target(), path, measured.size(), measured.sha256(), OverwriteMode.REPLACE, new FileAccess.Direct(),
                new PathPolicyBinding.NoRootPolicy(), new TransferLimits(remaining(), request.limits().maxFileSize()));
            UploadResult uploaded = transfer.upload(upload, request.tarball(), control);
            return switch (uploaded) {
                case UploadResult.Published published -> null;
                case UploadResult.NotDispatched notDispatched -> abort(new AgentCliInstallResult.NotDispatched(notDispatched.cause()));
                case UploadResult.Refused refused -> {
                    LOG.warn("The upload of the package was refused: {} ({})", refused.code(), refused.diagnostic());
                    yield abort(new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
                }
                case UploadResult.RolledBack rolledBack -> abort(new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
                case UploadResult.Unconfirmed unconfirmed -> new AgentCliInstallResult.Unconfirmed(unconfirmed.cause(), 0);
            };
        }

        /** The unpack command, sent once; null when it ended with 0. */
        private AgentCliInstallResult unpack() {
            PreparedCommand command = new PreparedCommand(AgentCliStep.UNPACK.in(plan).commandLine(), StdinBytes.none(), CommandKind.COMMAND);
            ExecutionLimits limits = new ExecutionLimits(remaining(), ExecutionLimits.DEFAULT_STOP_GRACE, SMALL_OUTPUT);
            Collected output = new Collected();
            ExecutionOutcome outcome = executor.run(new RemoteExecution(request.target(), command, limits, ExecReply.NOT_AWAITED), output, control).outcome();
            if (outcome.reason() == ExecutionReason.EXIT && outcome.exit() instanceof ExitStatus.Exited exited && outcome.failure().code() != ExecutionErrorCode.SSH_CONNECT_FAILED) {
                if (exited.code() == 0) {
                    return null;
                }
                LOG.warn("The unpack command of the agent CLI ended with exit code {}; the end of its standard error: [{}]", exited.code(), output.errorTail());
                return abort(new AgentCliInstallResult.Refused(exited.code() == TAR_NOT_FOUND ? AgentCliRefusal.PREREQUISITE_MISSING : AgentCliRefusal.INSTALL_COMMAND_FAILED));
            }
            TransferFailureCause cause = causeOf(outcome);
            LOG.warn("The unpack command of the agent CLI did not end with an exit code: {}", cause);
            return outcome.remoteState() == io.github.jaeseongs95.portal.domain.operation.RemoteState.NOT_DISPATCHED
                ? abort(new AgentCliInstallResult.NotDispatched(cause))
                : new AgentCliInstallResult.Unconfirmed(new UnconfirmedCause.TransportLost(), failures);
        }

        /**
         * The switch and what follows it: from here the target may have changed, so every failure is either undone and confirmed undone, or unknown. No deadline stops these
         * steps (half a switch is worse than a late one).
         */
        private AgentCliInstallResult switchAndConfirm(String previous, String name) {
            IOException switchFailure = null;
            try {
                current.switchTo(name);
            } catch (IOException e) {
                switchFailure = e;
            }
            String seen;
            try {
                seen = current.read();
            } catch (IOException e) {
                return unknown(e);
            }
            if (seen.equals(previous) && switchFailure != null) {
                // The switch did not happen and nothing changed: the old version is still current.
                LOG.warn("The switch of the current agent CLI failed and the old version is still current", switchFailure);
                failures += removeTree(finalDirectory);
                return new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED);
            }
            if (seen.equals(name)) {
                try {
                    if (packageVersion(finalDirectory + "/package/package.json").equals(release.version())) {
                        return new AgentCliInstallResult.Installed(new CliVersion(release.version()), failures, clock.instant());
                    }
                } catch (IOException e) {
                    if (connectionBroken(e)) {
                        return unknown(e);
                    }
                    LOG.warn("The package of the new current agent CLI could not be read back", e);
                }
            }
            return rollBack(previous);
        }

        private AgentCliInstallResult rollBack(String previous) {
            try {
                if (previous.isEmpty()) {
                    current.clear();
                } else {
                    current.switchTo(previous);
                }
            } catch (IOException e) {
                LOG.warn("The old current agent CLI could not be put back", e);
            }
            String restored;
            try {
                restored = current.read();
            } catch (IOException e) {
                return unknown(e);
            }
            if (restored.equals(previous)) {
                return new AgentCliInstallResult.RolledBack(AgentCliRefusal.INSTALL_COMMAND_FAILED, new RestoreEvidence(clock.instant()), failures);
            }
            return new AgentCliInstallResult.Unconfirmed(new UnconfirmedCause.RestoreUnconfirmed("current"), failures);
        }

        private AgentCliInstallResult unknown(IOException cause) {
            lease.discard();
            LOG.warn("The state of the agent CLI installation is not known", cause);
            return new AgentCliInstallResult.Unconfirmed(new UnconfirmedCause.TransportLost(), failures);
        }

        /** A failure over SFTP before the package was uploaded: nothing but directories was made. */
        private AgentCliInstallResult failedBeforeUpload(IOException e) {
            if (connectionBroken(e)) {
                lease.discard();
                return new AgentCliInstallResult.NotDispatched(TransferFailureCause.TRANSPORT_LOST);
            }
            LOG.warn("The directories of the agent CLI could not be made", e);
            return abort(new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
        }

        /** A failure over SFTP after the package was uploaded and before the switch: the old version is still current. */
        private AgentCliInstallResult failedBeforeSwitch(IOException e) {
            if (connectionBroken(e)) {
                return unknown(e);
            }
            LOG.warn("A step of the agent CLI installation failed before the switch", e);
            return abort(new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
        }

        /** The failure is no answer of the server: the connection broke. */
        private boolean connectionBroken(IOException e) {
            return !(e instanceof SftpException) || !lease.session().isOpen();
        }

        /** Ends the installation before the switch: removes the partial directory and returns {@code result}, or {@code Unconfirmed} when the removal is not confirmed. */
        private AgentCliInstallResult abort(AgentCliInstallResult result) {
            int left = removeTree(partial);
            if (left == 0) {
                return result;
            }
            return new AgentCliInstallResult.Unconfirmed(new UnconfirmedCause.CleanupUnconfirmed(layout.versionDirectory() + ".partial"), left);
        }

        /** A cancel or the time limit before the switch: the partial directory is removed and the answer says whether that is confirmed. */
        private Optional<AgentCliInstallResult> stopBefore() {
            TransferFailureCause cause;
            if (control.cancel().requested()) {
                cause = TransferFailureCause.CANCELLED;
            } else if (!clock.instant().isBefore(end)) {
                cause = TransferFailureCause.DEADLINE;
            } else {
                return Optional.empty();
            }
            return Optional.of(abort(new AgentCliInstallResult.NotDispatched(cause)));
        }

        private Duration remaining() {
            Duration left = Duration.between(clock.instant(), end);
            return left.compareTo(ONE_MILLISECOND) < 0 ? ONE_MILLISECOND : left;
        }

        // ---- SFTP and Java ----

        private void remove(String path) {
            try {
                client.remove(path);
            } catch (IOException e) {
                failures++;
                LOG.warn("A file of the agent CLI installation could not be removed", e);
            }
        }

        /** The version in the metadata file of a package, empty when the file has none. */
        private String packageVersion(String path) throws IOException {
            byte[] bytes;
            try (InputStream in = client.read(path)) {
                bytes = in.readNBytes(METADATA_LIMIT);
            }
            try {
                JsonNode node = json.readTree(bytes);
                return node.path("version").asString("");
            } catch (tools.jackson.core.JacksonException e) {
                return "";
            }
        }

        /** Makes the directory and the ones above it that are missing. */
        private void makeDirectories(String absolute) throws IOException {
            StringBuilder prefix = new StringBuilder();
            for (String part : absolute.split("/")) {
                if (part.isEmpty()) {
                    continue;
                }
                prefix.append('/').append(part);
                boolean drive = prefix.length() == 3 && prefix.charAt(2) == ':';
                if (!drive) {
                    ensureDirectory(prefix.toString());
                }
            }
        }

        private void ensureDirectory(String path) throws IOException {
            try {
                if (client.lstat(path).isDirectory()) {
                    return;
                }
                throw new IOException("A part of the installation path is not a directory");
            } catch (SftpException notThere) {
                client.mkdir(path);
            }
        }

        /** Removes a file or a directory tree without following links; the number of removals that failed. */
        private int removeTree(String path) {
            SftpClient.Attributes attributes;
            try {
                attributes = client.lstat(path);
            } catch (SftpException notThere) {
                return notThere.getStatus() == SftpConstants.SSH_FX_NO_SUCH_FILE || notThere.getStatus() == SftpConstants.SSH_FX_NO_SUCH_PATH ? 0 : 1;
            } catch (IOException e) {
                return 1;
            }
            int failed = 0;
            if (attributes.isDirectory() && !attributes.isSymbolicLink()) {
                try {
                    for (SftpClient.DirEntry entry : client.readDir(path)) {
                        String entryName = entry.getFilename();
                        if (!".".equals(entryName) && !"..".equals(entryName)) {
                            failed += removeTree(path + "/" + entryName);
                        }
                    }
                    client.rmdir(path);
                } catch (IOException e) {
                    failed++;
                }
                return failed;
            }
            try {
                client.remove(path);
            } catch (IOException e) {
                failed++;
            }
            return failed;
        }
    }

    // ---- shared parts ----

    /** The path of a file on the target in the syntax of the target: an SFTP path {@code /C:/Users/x} is the Windows path {@code C:/Users/x}. */
    private static RemotePath remotePath(String sftpPath) {
        return RemotePath.parse(DRIVE_PATH.matcher(sftpPath).matches() ? sftpPath.substring(1) : sftpPath);
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

    private static void closeQuietly(SftpClient client) {
        try {
            client.close();
        } catch (IOException e) {
            LOG.debug("The SFTP channel was already closed", e);
        }
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
                closeQuietly(client);
            }
        }
    }

    /** What the target shows, from {@code current} and the credential file of the tool. */
    private AgentCliStatusResult observe(SftpClient client, AgentCliStatusRequest request) throws IOException {
        String home = client.canonicalPath(".");
        String base = home.endsWith("/") ? home : home + "/";
        String name = new CurrentLink(client, base + AgentCliLayout.providerRoot(request.provider())).read();
        Matcher directory = VERSION_DIRECTORY.matcher(name);
        if (!directory.matches()) {
            return new AgentCliStatusResult.Observed(new RemoteStatus.NotFound(), revisionOf(name.isEmpty() ? "none" : name), LoginState.NOT_INSTALLED);
        }
        RemoteStatus remote = new RemoteStatus.Known(RemoteState.COMPLETED, new CliVersion(directory.group(1)), 0);
        return new AgentCliStatusResult.Observed(remote, revisionOf(name), loginOf(client, base, request.provider()));
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

    /** The digest of the installation as seen: of the release directory that is current, so a change of version is a change of revision. */
    private Digest revisionOf(String seen) {
        StreamDigest digest = StreamDigest.sha256();
        byte[] bytes = ("agent-cli-installation:" + seen).getBytes(StandardCharsets.UTF_8);
        digest.update(bytes, 0, bytes.length);
        return digest.finishSha256();
    }
}
