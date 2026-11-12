package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.app.remote.DownloadRequest;
import io.github.jaeseongs95.portal.app.remote.DownloadResult;
import io.github.jaeseongs95.portal.app.remote.ElevationPlan;
import io.github.jaeseongs95.portal.app.remote.ElevationRequest;
import io.github.jaeseongs95.portal.app.remote.ElevationResult;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionLimits;
import io.github.jaeseongs95.portal.app.remote.FileAccess;
import io.github.jaeseongs95.portal.app.remote.FileDiagnostic;
import io.github.jaeseongs95.portal.app.remote.PayloadSink;
import io.github.jaeseongs95.portal.app.remote.PayloadSource;
import io.github.jaeseongs95.portal.app.remote.PermissionRequest;
import io.github.jaeseongs95.portal.app.remote.PermissionResult;
import io.github.jaeseongs95.portal.app.remote.PermissionSupport;
import io.github.jaeseongs95.portal.app.remote.RemoteFileTransfer;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.app.remote.UnconfirmedCause;
import io.github.jaeseongs95.portal.app.remote.UploadRequest;
import io.github.jaeseongs95.portal.app.remote.UploadResult;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import java.io.Closeable;
import java.io.IOException;
import java.time.Clock;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.function.Function;
import org.apache.sshd.sftp.client.SftpClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.stereotype.Component;

/**
 * File work on a target over SFTP, on Apache MINA SSHD: the implementation of the {@link RemoteFileTransfer} port (stage 3 design 4). It owns the life of one transfer
 * and nothing about how the file is moved: it leases a session from the pool, calls the dispatch guard (the last check before anything is written), opens the SFTP
 * channel, watches the time limit and the cancel, and hands the work to {@link SftpUploader}, {@link SftpDownloader} or the permission step; the replacement of a file
 * is {@link AtomicReplacer}'s, the checks of a path are {@link RemotePathChecker}'s and the meaning of an SFTP failure is {@link SftpFailureClassifier}'s. It never
 * connects and never reconnects: a session that is not there is a result ({@code NotDispatched}), and a connection that breaks after a write is {@code Unconfirmed}
 * and its session is discarded. Nothing is sent twice.
 *
 * <p>What a result says (the ports' sealed types):
 * <ul>
 *   <li>an upload is {@code Published} only after the replacement was read back (defect D-0035), {@code Refused} where the target is confirmed unchanged,
 *       {@code RolledBack} where a replacement was undone and the original is confirmed back, {@code Unconfirmed} otherwise, and {@code NotDispatched} when nothing was
 *       written;</li>
 *   <li>a download only reads: it is {@code Fetched}, {@code Refused} with the code the server's answer gives (permission denied is {@code PERMISSION_DENIED} and
 *       nothing else), {@code TooLarge}, or {@code Failed} (a lost connection is {@code Failed(TRANSPORT_LOST)}, never an unknown outcome: decision D3-17, defect
 *       D-0013);</li>
 *   <li>permission bits: a target that cannot set them ({@code PermissionSupport.Unsupported}, a Windows target) is answered without calling SFTP.</li>
 * </ul>
 * An elevated request ({@link FileAccess.Elevated}) is served by the {@link ElevationPlan} it carries, and in both cases by the same adapter code as a plain one: a POSIX
 * target by the SFTP server of the target started with {@code sudo -n} ({@link SudoSftpChannels}; no server program or a {@code sudo} that needs a password refuses the
 * request before anything is written), a Windows target by the administrator probe and then the plain SFTP channel (its login either is the administrator's or is not).
 * What the 2.x Windows helper checked about owners and DACLs is not done here (decision D3-02): the {@code UNTRUSTED_OWNER}, {@code MISSING_DACL},
 * {@code UNSAFE_ANCESTOR}, {@code UNTRUSTED_WRITER}, {@code UNSUPPORTED_ACE} and {@code SECURITY_DESCRIPTOR_TOO_LARGE} codes stay in the contract and are never produced,
 * because the SYSTEM-owned staging root they guarded does not exist in 3.0, SFTP runs with the rights of the login account (the operating system's check is the first
 * control), and the same check refused files wrongly (defect D-0001).
 */
@Component
public class MinaRemoteFileTransfer implements RemoteFileTransfer {

    private static final Logger LOG = LoggerFactory.getLogger(MinaRemoteFileTransfer.class);

    /** The work done on an open SFTP channel; it answers with the result of the port. */
    @FunctionalInterface
    private interface SftpWork<R> {
        R run(SftpClient client, SessionLease lease, TransferWatch watch);
    }

    private final SessionSource sessions;
    private final SftpChannels channels;
    private final RemotePathChecker checker;
    private final SftpUploader uploader;
    private final SftpDownloader downloader;
    private final SftpFailureClassifier classifier;
    private final SudoSftpChannels sudoChannels;
    private final ElevationProbe elevationProbe;
    private final TaskScheduler scheduler;
    private final Clock clock;
    private final List<HiddenLinkProbe> linkProbes;

    /**
     * @param sessions where the leased sessions come from (the session pool)
     * @param channels opens the SFTP channel of a session
     * @param checker the allowed-root rule and the checks of a path
     * @param uploader writes a file
     * @param downloader reads a file
     * @param classifier the meaning of an SFTP failure
     * @param sudoChannels opens the SFTP channel of the SFTP server run under {@code sudo -n}, for an elevated request on a POSIX target
     * @param elevationProbe asks a target whether elevated file work is allowed
     * @param scheduler runs the deadline of a transfer
     * @param clock the one source of time
     * @param linkProbes the checks for the links that the SFTP server of some targets does not show (a Windows junction); a path is checked by the first that applies
     */
    public MinaRemoteFileTransfer(SessionSource sessions, SftpChannels channels, RemotePathChecker checker, SftpUploader uploader, SftpDownloader downloader,
                                  SftpFailureClassifier classifier, SudoSftpChannels sudoChannels, ElevationProbe elevationProbe, TaskScheduler scheduler, Clock clock,
                                  List<HiddenLinkProbe> linkProbes) {
        this.linkProbes = List.copyOf(linkProbes);
        this.sessions = Objects.requireNonNull(sessions, "sessions");
        this.channels = Objects.requireNonNull(channels, "channels");
        this.checker = Objects.requireNonNull(checker, "checker");
        this.uploader = Objects.requireNonNull(uploader, "uploader");
        this.downloader = Objects.requireNonNull(downloader, "downloader");
        this.classifier = Objects.requireNonNull(classifier, "classifier");
        this.sudoChannels = Objects.requireNonNull(sudoChannels, "sudoChannels");
        this.elevationProbe = Objects.requireNonNull(elevationProbe, "elevationProbe");
        this.scheduler = Objects.requireNonNull(scheduler, "scheduler");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    @Override
    public UploadResult upload(UploadRequest request, PayloadSource source, ExecutionControl control) {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(source, "source");
        Objects.requireNonNull(control, "control");
        if (request.sizeBytes() > request.limits().maxFileSize().toBytes()) {
            return new UploadResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None(), CleanupState.COMPLETE);
        }
        if (checker.judgePolicy(request.target().id(), request.path(), request.pathPolicy()) instanceof PolicyVerdict.Refused refused) {
            return new UploadResult.Refused(refused.code(), refused.diagnostic(), CleanupState.COMPLETE);
        }
        HiddenLinkProbe.Verdict hidden = hiddenLinks(request.target(), request.path(), request.limits(), control);
        if (hidden instanceof HiddenLinkProbe.Linked) {
            return new UploadResult.Refused(TransferErrorCode.UNSAFE_PATH, new FileDiagnostic.None(), CleanupState.COMPLETE);
        }
        if (hidden instanceof HiddenLinkProbe.Unverified) {
            return new UploadResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None(), CleanupState.COMPLETE);
        }
        if (hidden instanceof HiddenLinkProbe.NotRun notRun) {
            return new UploadResult.NotDispatched(notRun.cause());
        }
        return switch (request.access()) {
            case FileAccess.Direct direct -> uploadDirect(request, source, control);
            case FileAccess.Elevated elevated -> switch (elevated.plan()) {
                case ElevationPlan.SudoNonInteractive sudo -> uploadOver(request, source, control, true);
                case ElevationPlan.WindowsAdministratorCheck check -> switch (administrator(request.target(), check, request.limits(), control)) {
                    case ElevationResult.Granted granted -> uploadDirect(request, source, control);
                    case ElevationResult.Denied denied -> new UploadResult.Refused(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.None(), CleanupState.COMPLETE);
                    case ElevationResult.NotApplicable notApplicable -> new UploadResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None(), CleanupState.COMPLETE);
                    case ElevationResult.Unavailable unavailable -> new UploadResult.NotDispatched(unavailable.cause());
                };
                case ElevationPlan.NotSupported notSupported -> new UploadResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None(), CleanupState.COMPLETE);
            };
        };
    }

    @Override
    public DownloadResult download(DownloadRequest request, PayloadSink sink, ExecutionControl control) {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(sink, "sink");
        Objects.requireNonNull(control, "control");
        if (checker.judgePolicy(request.target().id(), request.path(), request.pathPolicy()) instanceof PolicyVerdict.Refused refused) {
            return new DownloadResult.Refused(refused.code(), refused.diagnostic());
        }
        HiddenLinkProbe.Verdict hidden = hiddenLinks(request.target(), request.path(), request.limits(), control);
        if (hidden instanceof HiddenLinkProbe.Linked) {
            return new DownloadResult.Refused(TransferErrorCode.UNSAFE_PATH, new FileDiagnostic.None());
        }
        if (hidden instanceof HiddenLinkProbe.Unverified) {
            return new DownloadResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None());
        }
        if (hidden instanceof HiddenLinkProbe.NotRun notRun) {
            return new DownloadResult.Failed(notRun.cause());
        }
        return switch (request.access()) {
            case FileAccess.Direct direct -> downloadDirect(request, sink, control);
            case FileAccess.Elevated elevated -> switch (elevated.plan()) {
                case ElevationPlan.SudoNonInteractive sudo -> downloadOver(request, sink, control, true);
                case ElevationPlan.WindowsAdministratorCheck check -> switch (administrator(request.target(), check, request.limits(), control)) {
                    case ElevationResult.Granted granted -> downloadDirect(request, sink, control);
                    case ElevationResult.Denied denied -> new DownloadResult.Refused(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.None());
                    case ElevationResult.NotApplicable notApplicable -> new DownloadResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None());
                    case ElevationResult.Unavailable unavailable -> new DownloadResult.Failed(unavailable.cause());
                };
                case ElevationPlan.NotSupported notSupported -> new DownloadResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None());
            };
        };
    }

    @Override
    public PermissionResult applyPermissions(PermissionRequest request, ExecutionControl control) {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(control, "control");
        if (request.support() instanceof PermissionSupport.Unsupported unsupported) {
            return new PermissionResult.Unsupported(unsupported.reason());
        }
        if (checker.judgePolicy(request.target().id(), request.path(), request.pathPolicy()) instanceof PolicyVerdict.Refused refused) {
            return new PermissionResult.Refused(refused.code(), refused.diagnostic());
        }
        HiddenLinkProbe.Verdict hidden = hiddenLinks(request.target(), request.path(), request.limits(), control);
        if (hidden instanceof HiddenLinkProbe.Linked) {
            return new PermissionResult.Refused(TransferErrorCode.UNSAFE_PATH, new FileDiagnostic.None());
        }
        if (hidden instanceof HiddenLinkProbe.Unverified) {
            return new PermissionResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None());
        }
        if (hidden instanceof HiddenLinkProbe.NotRun notRun) {
            return new PermissionResult.NotDispatched(notRun.cause());
        }
        return switch (request.access()) {
            case FileAccess.Direct direct -> permissionsDirect(request, control);
            case FileAccess.Elevated elevated -> switch (elevated.plan()) {
                case ElevationPlan.SudoNonInteractive sudo -> permissionsOver(request, control, true);
                case ElevationPlan.WindowsAdministratorCheck check -> new PermissionResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None());
                case ElevationPlan.NotSupported notSupported -> new PermissionResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None());
            };
        };
    }

    @Override
    public ElevationResult checkElevation(ElevationRequest request, ExecutionControl control) {
        return elevationProbe.check(request, control);
    }

    /** The links the SFTP server does not show, for a path of a syntax that has a probe; a path that no probe wants is clear (the SFTP inspection decides). */
    private HiddenLinkProbe.Verdict hiddenLinks(RemoteTarget target, RemotePath path, TransferLimits limits, ExecutionControl control) {
        for (HiddenLinkProbe probe : linkProbes) {
            if (probe.applies(path)) {
                return probe.check(target, path, limits, control);
            }
        }
        return new HiddenLinkProbe.Clear();
    }

    // ---- the direct paths ----

    private UploadResult uploadDirect(UploadRequest request, PayloadSource source, ExecutionControl control) {
        return uploadOver(request, source, control, false);
    }

    /** The upload over the plain SFTP channel, or over the elevated one: the work is the same code. */
    private UploadResult uploadOver(UploadRequest request, PayloadSource source, ExecutionControl control, boolean elevated) {
        return withSftp(request.target(), request.limits(), control, elevated, UploadResult.NotDispatched::new,
            code -> new UploadResult.Refused(code, new FileDiagnostic.None(), CleanupState.COMPLETE),
            (client, lease, watch) -> uploader.upload(client, lease, watch, request, source));
    }

    private DownloadResult downloadDirect(DownloadRequest request, PayloadSink sink, ExecutionControl control) {
        return downloadOver(request, sink, control, false);
    }

    private DownloadResult downloadOver(DownloadRequest request, PayloadSink sink, ExecutionControl control, boolean elevated) {
        return withSftp(request.target(), request.limits(), control, elevated, DownloadResult.Failed::new,
            code -> new DownloadResult.Refused(code, new FileDiagnostic.None()),
            (client, lease, watch) -> downloader.download(client, lease, watch, request, sink));
    }

    private PermissionResult permissionsDirect(PermissionRequest request, ExecutionControl control) {
        return permissionsOver(request, control, false);
    }

    private PermissionResult permissionsOver(PermissionRequest request, ExecutionControl control, boolean elevated) {
        return withSftp(request.target(), request.limits(), control, elevated, PermissionResult.NotDispatched::new,
            code -> new PermissionResult.Refused(code, new FileDiagnostic.None()),
            (client, lease, watch) -> setPermissions(client, lease, request));
    }

    private PermissionResult setPermissions(SftpClient client, SessionLease lease, PermissionRequest request) {
        SftpLocation location = new SftpLocation(request.path());
        PathInspection inspection = checker.inspect(client, location);
        switch (inspection) {
            case PathInspection.Lost lost -> {
                lease.discard();
                return new PermissionResult.NotDispatched(TransferFailureCause.TRANSPORT_LOST);
            }
            case PathInspection.Refused refused -> {
                return new PermissionResult.Refused(refused.code(), refused.diagnostic());
            }
            case PathInspection.Absent absent -> {
                return new PermissionResult.Refused(TransferErrorCode.FILE_NOT_FOUND, new FileDiagnostic.None());
            }
            case PathInspection.Present present -> {
                // the file is a regular file: go on
            }
        }
        try {
            client.setStat(location.file(), new SftpClient.Attributes().perms(request.mode().bits()));
        } catch (IOException e) {
            return switch (classifier.verdict(e, SftpFailureClassifier.Site.TARGET_FILE)) {
                case SftpFailureClassifier.Verdict.Refusal refusal -> new PermissionResult.Refused(refusal.code(), refusal.diagnostic());
                case SftpFailureClassifier.Verdict.Lost lost -> {
                    lease.discard();
                    yield new PermissionResult.Unconfirmed(new UnconfirmedCause.TransportLost());
                }
            };
        }
        try {
            int bits = client.lstat(location.file()).getPermissions() & 0777;
            return bits == request.mode().bits()
                ? new PermissionResult.Applied()
                : new PermissionResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None());
        } catch (IOException e) {
            lease.discard();
            return new PermissionResult.Unconfirmed(new UnconfirmedCause.TransportLost());
        }
    }

    /** The administrator probe of a Windows target: the whole elevated work is the same SFTP work when the connection is the administrator's. */
    private ElevationResult administrator(RemoteTarget target, ElevationPlan.WindowsAdministratorCheck check, TransferLimits limits, ExecutionControl control) {
        ExecutionLimits probeLimits = new ExecutionLimits(limits.deadline(), ExecutionLimits.DEFAULT_STOP_GRACE, ExecutionLimits.DEFAULT_OUTPUT_PER_STREAM);
        return elevationProbe.check(new ElevationRequest(target, check, probeLimits), control);
    }

    // ---- the life of one transfer ----

    /**
     * Leases a session, calls the guard, opens the SFTP channel and runs the work with the watch armed. A session or a channel that cannot be had is the result of
     * {@code notDispatched}; a {@code DispatchRefusedException} of the guard passes out after the lease is closed, with nothing sent.
     */
    private <R> R withSftp(RemoteTarget target, TransferLimits limits, ExecutionControl control, boolean elevated, Function<TransferFailureCause, R> notDispatched,
                           Function<TransferErrorCode, R> refused, SftpWork<R> work) {
        try (TransferWatch watch = new TransferWatch(scheduler, clock, limits.deadline(), control.cancel())) {
            return switch (sessions.lease(target, control.cancel())) {
                case SessionAcquisition.Unavailable unavailable -> notDispatched.apply(unavailable.cause());
                case SessionAcquisition.Acquired acquired -> withLease(acquired.lease(), control, watch, elevated, notDispatched, refused, work);
            };
        }
    }

    /** What opening the SFTP channel of a transfer came to. */
    private sealed interface Attempt permits Attempt.Ready, Attempt.Refused, Attempt.Unreachable {
        record Ready(SftpClient client) implements Attempt {
        }

        /** The target cannot serve the elevated request: no SFTP server program, or {@code sudo -n} does not start it. */
        record Refused(TransferErrorCode code) implements Attempt {
        }

        record Unreachable(TransferFailureCause cause) implements Attempt {
        }
    }

    private Attempt attempt(SessionLease lease, boolean elevated, TransferWatch watch) {
        if (elevated) {
            return switch (sudoChannels.open(lease.session())) {
                case SudoSftpChannels.Opening.Opened opened -> new Attempt.Ready(opened.client());
                case SudoSftpChannels.Opening.NoServer noServer -> new Attempt.Refused(TransferErrorCode.INVALID_REQUEST);
                case SudoSftpChannels.Opening.NotStarted notStarted -> new Attempt.Refused(TransferErrorCode.PERMISSION_DENIED);
                case SudoSftpChannels.Opening.Lost lost -> {
                    lease.discard();
                    yield new Attempt.Unreachable(watch.fired().orElse(TransferFailureCause.TRANSPORT_LOST));
                }
            };
        }
        try {
            return new Attempt.Ready(channels.open(lease.session()));
        } catch (IOException e) {
            boolean sessionAlive = lease.session().isOpen();
            if (!sessionAlive) {
                lease.discard();
            }
            LOG.debug("The SFTP channel could not be opened", e);
            return new Attempt.Unreachable(watch.fired().orElse(sessionAlive ? TransferFailureCause.CHANNEL_OPEN_FAILED : TransferFailureCause.TRANSPORT_LOST));
        }
    }

    private <R> R withLease(SessionLease lease, ExecutionControl control, TransferWatch watch, boolean elevated, Function<TransferFailureCause, R> notDispatched,
                            Function<TransferErrorCode, R> refused, SftpWork<R> work) {
        try (lease) {
            control.guard().beforeDispatch();
            Optional<TransferFailureCause> stopped = watch.stopRequested();
            if (stopped.isPresent()) {
                return notDispatched.apply(stopped.orElseThrow());
            }
            SftpClient client;
            switch (attempt(lease, elevated, watch)) {
                case Attempt.Ready ready -> client = ready.client();
                case Attempt.Refused denied -> {
                    return refused.apply(denied.code());
                }
                case Attempt.Unreachable unreachable -> {
                    return notDispatched.apply(unreachable.cause());
                }
            }
            watch.interruptWith(() -> closeQuietly(client));
            try {
                return work.run(client, lease, watch);
            } finally {
                watch.disarm();
                closeQuietly(client);
            }
        }
    }

    private static void closeQuietly(Closeable closeable) {
        try {
            closeable.close();
        } catch (IOException e) {
            LOG.debug("A channel was already closed", e);
        }
    }
}
