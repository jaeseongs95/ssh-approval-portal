package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.app.remote.FileDiagnostic;
import io.github.jaeseongs95.portal.app.remote.PayloadSource;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.app.remote.UnconfirmedCause;
import io.github.jaeseongs95.portal.app.remote.UploadRequest;
import io.github.jaeseongs95.portal.app.remote.UploadResult;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.path.WindowsRemotePath;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.util.EnumSet;
import java.util.Objects;
import java.util.Optional;
import org.apache.sshd.sftp.client.SftpClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * The upload over an open SFTP channel (stage 3 design 4.2 steps 1 to 3; the replacement is {@link AtomicReplacer}'s). The order is what makes the result honest:
 * <ol>
 *   <li>the target is looked at ({@link RemotePathChecker}): a link, a directory, a missing parent or a file that must not be replaced end the upload here, with the
 *       target untouched;</li>
 *   <li>the temporary file {@code .ssh-approval-<hex>.part} is made next to the target with an exclusive create, so it can never be somebody else's file, and gets
 *       the mode {@code 0600} (a path in Windows syntax has no mode: its SFTP server does not support {@code chmod});</li>
 *   <li>the bytes flow from the {@link PayloadSource} to the server in blocks, and the SHA-256 and the size are counted on the way: a stream that is not the announced
 *       file ends the upload ({@code FILE_CHANGED}), the temporary file is removed;</li>
 *   <li>the temporary file is read back and hashed again (decision D3-11, on by default: the files are at most 64 MiB), so a byte changed on the way or on the
 *       server's disk is found before the file is put in place;</li>
 *   <li>the {@link AtomicReplacer} puts it in place and reads it back.</li>
 * </ol>
 * A stop from outside (the time limit, the owner's cancel) before the replacement removes the temporary file with a channel of its own and is reported as
 * {@code NotDispatched} when that is confirmed, and as {@code Unconfirmed(CleanupUnconfirmed)} when it is not. A lost connection after the temporary file was created is
 * {@code Unconfirmed(TransportLost)} and the session is discarded: nothing is sent again.
 */
@Component
public class SftpUploader {

    private static final Logger LOG = LoggerFactory.getLogger(SftpUploader.class);
    private static final int BLOCK_BYTES = 64 * 1024;
    /** {@code 0600}: read and write for the owner, nothing for anybody else. */
    private static final int OWNER_ONLY = 0600;

    private final RemotePathChecker checker;
    private final AtomicReplacer replacer;
    private final SftpFailureClassifier classifier;
    private final SftpChannels channels;
    private final SpaceProbe spaceProbe;

    /**
     * @param checker looks at the path before anything is written
     * @param replacer puts the temporary file in place
     * @param classifier the meaning of an SFTP failure
     * @param channels opens a channel of its own for the clean-up after a stop
     * @param spaceProbe tells a full disk from a plain failure
     */
    public SftpUploader(RemotePathChecker checker, AtomicReplacer replacer, SftpFailureClassifier classifier, SftpChannels channels, SpaceProbe spaceProbe) {
        this.checker = Objects.requireNonNull(checker, "checker");
        this.replacer = Objects.requireNonNull(replacer, "replacer");
        this.classifier = Objects.requireNonNull(classifier, "classifier");
        this.channels = Objects.requireNonNull(channels, "channels");
        this.spaceProbe = Objects.requireNonNull(spaceProbe, "spaceProbe");
    }

    /** What copying the bytes (or reading them back) came to. */
    private sealed interface Copy permits Copy.Copied, Copy.Mismatch, Copy.Stopped, Copy.LocalFailure, Copy.RemoteFailure {
        record Copied(Digest sha256, long bytes) implements Copy {
        }

        /** The stream is not the announced file: another size than announced. */
        record Mismatch() implements Copy {
        }

        record Stopped(TransferFailureCause cause) implements Copy {
        }

        /** The local side failed: the artifact cannot be read. */
        record LocalFailure() implements Copy {
        }

        record RemoteFailure(IOException cause) implements Copy {
        }
    }

    /**
     * Writes the file and puts it in place.
     *
     * @param client the SFTP client of the leased session
     * @param lease the lease; it is discarded when the connection is lost
     * @param watch the time limit and the cancel of this transfer
     * @param request the file to publish
     * @param source the bytes
     * @return how the upload ended
     */
    UploadResult upload(SftpClient client, SessionLease lease, TransferWatch watch, UploadRequest request, PayloadSource source) {
        SftpLocation location = new SftpLocation(request.path());
        PathInspection original = checker.inspect(client, location);
        return switch (original) {
            case PathInspection.Lost lost -> {
                lease.discard();
                yield new UploadResult.NotDispatched(TransferFailureCause.TRANSPORT_LOST);
            }
            case PathInspection.Refused refused -> new UploadResult.Refused(refused.code(), refused.diagnostic(), CleanupState.COMPLETE);
            case PathInspection.Absent absent -> write(client, lease, watch, request, source, location, original);
            case PathInspection.Present present -> request.overwrite() == OverwriteMode.FAIL_IF_EXISTS
                ? new UploadResult.Refused(TransferErrorCode.DESTINATION_EXISTS, new FileDiagnostic.None(), CleanupState.COMPLETE)
                : write(client, lease, watch, request, source, location, original);
        };
    }

    private UploadResult write(SftpClient client, SessionLease lease, TransferWatch watch, UploadRequest request, PayloadSource source, SftpLocation location,
                               PathInspection original) {
        Optional<TransferFailureCause> stopped = watch.stopRequested();
        if (stopped.isPresent()) {
            return new UploadResult.NotDispatched(stopped.orElseThrow());
        }
        String tempName = replacer.newTempName();
        String tempPath = location.sibling(tempName);
        Optional<UploadResult> created = createTemporaryFile(client, lease, request, location, tempName, tempPath);
        if (created.isPresent()) {
            return created.orElseThrow();
        }
        Optional<UploadResult> written = check(client, lease, watch, location, tempName, tempPath, request, copy(client, watch, source, tempPath, request));
        if (written.isPresent()) {
            return written.orElseThrow();
        }
        Optional<UploadResult> verified = check(client, lease, watch, location, tempName, tempPath, request, readBack(client, watch, tempPath));
        if (verified.isPresent()) {
            return verified.orElseThrow();
        }
        Optional<UploadResult> moded = inheritMode(client, lease, location, tempName, tempPath, request, original);
        if (moded.isPresent()) {
            return moded.orElseThrow();
        }
        // From here the replacement runs to its end: a cancel or the time limit no longer stops it half way.
        watch.disarm();
        return replacer.replace(new ReplaceJob(client, location, tempName, original, request.overwrite(), request.sizeBytes(), request.sha256()));
    }

    // ---- the temporary file ----

    private Optional<UploadResult> createTemporaryFile(SftpClient client, SessionLease lease, UploadRequest request, SftpLocation location, String tempName,
                                                       String tempPath) {
        try (SftpClient.CloseableHandle handle = client.open(tempPath, EnumSet.of(SftpClient.OpenMode.Write, SftpClient.OpenMode.Create, SftpClient.OpenMode.Exclusive))) {
            if (!(request.path() instanceof WindowsRemotePath)) {
                protect(client, handle);
            }
            return Optional.empty();
        } catch (IOException e) {
            return Optional.of(failedRemotely(client, lease, location, tempName, tempPath, e, SftpFailureClassifier.Site.NEW_FILE));
        }
    }

    /**
     * Sets the mode of a new temporary file to {@code 0600}. A server that answers the plain failure or does not know the request leaves the file with the mode its umask
     * gives (the embedded server on a file system without POSIX modes does that); every other failure ends the upload, because a file that other accounts may read must
     * not receive the content.
     */
    private void protect(SftpClient client, SftpClient.Handle handle) throws IOException {
        try {
            client.setStat(handle, new SftpClient.Attributes().perms(OWNER_ONLY));
        } catch (IOException e) {
            SftpFailure.Kind kind = classifier.classify(e).kind();
            if (kind != SftpFailure.Kind.PLAIN_FAILURE && kind != SftpFailure.Kind.OTHER) {
                throw e;
            }
            LOG.debug("The server did not set the mode of the temporary file; it keeps the mode its umask gives it");
        }
    }

    /**
     * A file that is replaced keeps the permission bits it had (2.x kept the mode of an overwritten file): the temporary file gets them before it goes in place. The
     * same tolerance as for the first mode applies, and a path in Windows syntax has no mode.
     */
    private Optional<UploadResult> inheritMode(SftpClient client, SessionLease lease, SftpLocation location, String tempName, String tempPath, UploadRequest request,
                                               PathInspection original) {
        if (!(original instanceof PathInspection.Present present) || request.path() instanceof WindowsRemotePath) {
            return Optional.empty();
        }
        try {
            SftpClient.Attributes attributes = new SftpClient.Attributes().perms(present.state().permissions() & 0777);
            if (request.access() instanceof io.github.jaeseongs95.portal.app.remote.FileAccess.Elevated) {
                // An elevated server (sudo sftp-server) is root, whose new file belongs to root: the owner and group the file had are given back (only root may).
                attributes.owner(present.state().userId(), present.state().groupId());
            }
            client.setStat(tempPath, attributes);
            return Optional.empty();
        } catch (IOException e) {
            SftpFailure.Kind kind = classifier.classify(e).kind();
            if (kind == SftpFailure.Kind.PLAIN_FAILURE || kind == SftpFailure.Kind.OTHER) {
                return Optional.empty();
            }
            return Optional.of(failedRemotely(client, lease, location, tempName, tempPath, e, SftpFailureClassifier.Site.OWN_FILE));
        }
    }

    // ---- copying ----

    private Copy copy(SftpClient client, TransferWatch watch, PayloadSource source, String tempPath, UploadRequest request) {
        StreamDigest digest = StreamDigest.sha256();
        byte[] block = new byte[BLOCK_BYTES];
        OutputStream out;
        try {
            out = client.write(tempPath, EnumSet.of(SftpClient.OpenMode.Write));
        } catch (IOException e) {
            return new Copy.RemoteFailure(e);
        }
        try (PayloadRead payload = source.open()) {
            if (payload.size() != request.sizeBytes()) {
                return new Copy.Mismatch();
            }
            ByteBuffer buffer = ByteBuffer.wrap(block);
            while (true) {
                buffer.clear();
                int read;
                try {
                    read = payload.channel().read(buffer);
                } catch (IOException e) {
                    LOG.warn("The stored file of an upload could not be read", e);
                    return new Copy.LocalFailure();
                }
                if (read < 0) {
                    break;
                }
                Optional<TransferFailureCause> stopped = watch.stopRequested();
                if (stopped.isPresent()) {
                    return new Copy.Stopped(stopped.orElseThrow());
                }
                digest.update(block, 0, read);
                if (digest.count() > request.sizeBytes()) {
                    return new Copy.Mismatch();
                }
                out.write(block, 0, read);
            }
            out.close();
            out = null;
            return new Copy.Copied(digest.finishSha256(), digest.count());
        } catch (IOException e) {
            return new Copy.RemoteFailure(e);
        } finally {
            closeQuietly(out);
        }
    }

    private Copy readBack(SftpClient client, TransferWatch watch, String tempPath) {
        StreamDigest digest = StreamDigest.sha256();
        byte[] block = new byte[BLOCK_BYTES];
        try (InputStream in = client.read(tempPath)) {
            int read;
            while ((read = in.read(block)) >= 0) {
                Optional<TransferFailureCause> stopped = watch.stopRequested();
                if (stopped.isPresent()) {
                    return new Copy.Stopped(stopped.orElseThrow());
                }
                digest.update(block, 0, read);
            }
            return new Copy.Copied(digest.finishSha256(), digest.count());
        } catch (IOException e) {
            return new Copy.RemoteFailure(e);
        }
    }

    // ---- what the copy came to ----

    /** Turns a finished copy into the end of the upload, or says that the upload goes on (empty). */
    private Optional<UploadResult> check(SftpClient client, SessionLease lease, TransferWatch watch, SftpLocation location, String tempName, String tempPath,
                                         UploadRequest request, Copy copy) {
        return switch (copy) {
            case Copy.Copied copied -> copied.bytes() == request.sizeBytes() && copied.sha256().equals(request.sha256())
                ? Optional.empty()
                : Optional.of(cleanedRefusal(client, tempName, tempPath, TransferErrorCode.FILE_CHANGED, new FileDiagnostic.None()));
            case Copy.Mismatch mismatch -> Optional.of(cleanedRefusal(client, tempName, tempPath, TransferErrorCode.FILE_CHANGED, new FileDiagnostic.None()));
            case Copy.Stopped stopped -> Optional.of(stopped(lease, tempName, tempPath, stopped.cause()));
            case Copy.LocalFailure local -> Optional.of(stopped(lease, tempName, tempPath, TransferFailureCause.LOCAL_IO_FAILED));
            case Copy.RemoteFailure remote -> Optional.of(watch.fired().isPresent()
                ? stopped(lease, tempName, tempPath, watch.fired().orElseThrow())
                : failedRemotely(client, lease, location, tempName, tempPath, remote.cause(), SftpFailureClassifier.Site.OWN_FILE));
        };
    }

    /** A request the server refused or a connection that broke while the temporary file was being made, written or read. */
    private UploadResult failedRemotely(SftpClient client, SessionLease lease, SftpLocation location, String tempName, String tempPath, IOException cause,
                                        SftpFailureClassifier.Site site) {
        SftpFailure failure = classifier.classify(cause);
        return switch (classifier.verdict(failure, site)) {
            case SftpFailureClassifier.Verdict.Lost lost -> {
                lease.discard();
                yield new UploadResult.Unconfirmed(new UnconfirmedCause.TransportLost(), CleanupState.INCOMPLETE);
            }
            case SftpFailureClassifier.Verdict.Refusal refusal -> {
                boolean noSpace = failure.kind() == SftpFailure.Kind.PLAIN_FAILURE && spaceProbe.exhausted(client, location.directory());
                yield noSpace
                    ? cleanedRefusal(client, tempName, tempPath, TransferErrorCode.STAGING_UNAVAILABLE, new FileDiagnostic.NoSpace())
                    : cleanedRefusal(client, tempName, tempPath, refusal.code(), refusal.diagnostic());
            }
        };
    }

    /** The upload is refused and the target is unchanged: the temporary file is removed, and the result says whether that is confirmed. */
    private UploadResult cleanedRefusal(SftpClient client, String tempName, String tempPath, TransferErrorCode code, FileDiagnostic diagnostic) {
        if (replacer.remove(client, tempPath) == CleanupState.COMPLETE) {
            return new UploadResult.Refused(code, diagnostic, CleanupState.COMPLETE);
        }
        return new UploadResult.Unconfirmed(new UnconfirmedCause.CleanupUnconfirmed(tempName), CleanupState.INCOMPLETE);
    }

    /** A stop from outside: the temporary file is removed with a channel of its own, because the one the upload used was closed to stop it. */
    private UploadResult stopped(SessionLease lease, String tempName, String tempPath, TransferFailureCause cause) {
        CleanupState cleanup = removeWithFreshChannel(lease, tempPath);
        return cleanup == CleanupState.COMPLETE
            ? new UploadResult.NotDispatched(cause)
            : new UploadResult.Unconfirmed(new UnconfirmedCause.CleanupUnconfirmed(tempName), CleanupState.INCOMPLETE);
    }

    private CleanupState removeWithFreshChannel(SessionLease lease, String tempPath) {
        SftpClient fresh;
        try {
            fresh = channels.open(lease.session());
        } catch (IOException e) {
            return CleanupState.INCOMPLETE;
        }
        try {
            return replacer.remove(fresh, tempPath);
        } finally {
            closeQuietly(fresh);
        }
    }

    private static void closeQuietly(Closeable closeable) {
        if (closeable == null) {
            return;
        }
        try {
            closeable.close();
        } catch (IOException e) {
            LOG.debug("A channel was already closed", e);
        }
    }
}
