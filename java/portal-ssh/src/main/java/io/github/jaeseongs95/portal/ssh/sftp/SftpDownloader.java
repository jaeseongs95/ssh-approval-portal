package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.app.remote.DownloadRequest;
import io.github.jaeseongs95.portal.app.remote.DownloadResult;
import io.github.jaeseongs95.portal.app.remote.FileDiagnostic;
import io.github.jaeseongs95.portal.app.remote.PayloadSink;
import io.github.jaeseongs95.portal.app.remote.SinkResult;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import java.io.IOException;
import java.io.InputStream;
import java.util.Arrays;
import java.util.Objects;
import java.util.Optional;
import org.apache.sshd.sftp.client.SftpClient;
import org.springframework.stereotype.Component;

/**
 * The download over an open SFTP channel (stage 3 design 4.1 and 4.3). It only reads: it creates, renames and removes nothing on the target (the 2.x helper copied the
 * file into a staging folder first, which 3.0 does not have). So no download result leaves the target changed or unknown on its side, and a download that is cut short
 * is a failed read, never an {@code UNKNOWN} outcome (decision D3-17, defect D-0013: an 850-byte file that fails to arrive is a failure with its reason).
 *
 * <p>The order: the path is looked at ({@link RemotePathChecker}: no link, a regular file); the size comes from that look and above the limit the answer is
 * {@code TooLarge} before a byte is read; the bytes flow to the {@link PayloadSink} in blocks while the SHA-256 and the size are counted; the file is looked at again
 * afterwards. A size read that is not the size announced, or a file whose size, modification time or mode changed meanwhile, is {@code FILE_CHANGED} (the 2.x helper also
 * compared the inode and the change time, which SFTP attributes do not carry). A sink that fails ends the read at once.
 *
 * <p>What the failures come to: a status the server answered with (permission denied, no such file) is {@code Refused} with its own code; a lost connection is
 * {@code Failed(TRANSPORT_LOST)}; the time limit and the cancel are {@code Failed(DEADLINE)} and {@code Failed(CANCELLED)}. The adapter never reads the file again.
 */
@Component
public class SftpDownloader {

    private static final int BLOCK_BYTES = 64 * 1024;

    private final RemotePathChecker checker;
    private final SftpFailureClassifier classifier;

    /**
     * @param checker looks at the path before and after the read
     * @param classifier the meaning of an SFTP failure
     */
    public SftpDownloader(RemotePathChecker checker, SftpFailureClassifier classifier) {
        this.checker = Objects.requireNonNull(checker, "checker");
        this.classifier = Objects.requireNonNull(classifier, "classifier");
    }

    /**
     * Reads the file into the sink.
     *
     * @param client the SFTP client of the leased session
     * @param lease the lease; it is discarded when the connection is lost
     * @param watch the time limit and the cancel of this transfer
     * @param request the file to read
     * @param sink where the bytes go
     * @return how the download ended
     */
    DownloadResult download(SftpClient client, SessionLease lease, TransferWatch watch, DownloadRequest request, PayloadSink sink) {
        SftpLocation location = new SftpLocation(request.path());
        PathInspection before = checker.inspect(client, location);
        return switch (before) {
            case PathInspection.Lost lost -> {
                lease.discard();
                yield new DownloadResult.Failed(TransferFailureCause.TRANSPORT_LOST);
            }
            case PathInspection.Refused refused -> new DownloadResult.Refused(refused.code(), refused.diagnostic());
            case PathInspection.Absent absent -> new DownloadResult.Refused(TransferErrorCode.FILE_NOT_FOUND, new FileDiagnostic.None());
            case PathInspection.Present present -> read(client, lease, watch, request, sink, location, present.state());
        };
    }

    private DownloadResult read(SftpClient client, SessionLease lease, TransferWatch watch, DownloadRequest request, PayloadSink sink, SftpLocation location,
                                LeafState announced) {
        long limit = request.limits().maxFileSize().toBytes();
        if (announced.size() > limit) {
            return new DownloadResult.TooLarge(announced.size(), limit);
        }
        Optional<TransferFailureCause> stopped = watch.stopRequested();
        if (stopped.isPresent()) {
            return new DownloadResult.Failed(stopped.orElseThrow());
        }
        StreamDigest digest = StreamDigest.sha256();
        byte[] block = new byte[BLOCK_BYTES];
        try (InputStream in = client.read(location.file())) {
            int read;
            while ((read = in.read(block)) >= 0) {
                stopped = watch.stopRequested();
                if (stopped.isPresent()) {
                    return new DownloadResult.Failed(stopped.orElseThrow());
                }
                digest.update(block, 0, read);
                if (digest.count() > announced.size()) {
                    return changed(); // the file grew while it was read
                }
                if (sink.append(Arrays.copyOf(block, read)) instanceof SinkResult.Failed) {
                    return new DownloadResult.Failed(TransferFailureCause.LOCAL_IO_FAILED);
                }
            }
        } catch (IOException e) {
            return failedReading(lease, watch, e);
        }
        if (digest.count() != announced.size()) {
            return changed();
        }
        PathInspection after = checker.inspect(client, location);
        return switch (after) {
            case PathInspection.Present present -> present.state().equals(announced)
                ? new DownloadResult.Fetched(digest.count(), digest.finishSha256())
                : changed();
            case PathInspection.Absent absent -> changed();
            case PathInspection.Refused refused -> new DownloadResult.Refused(refused.code(), refused.diagnostic());
            case PathInspection.Lost lost -> {
                lease.discard();
                yield new DownloadResult.Failed(TransferFailureCause.TRANSPORT_LOST);
            }
        };
    }

    private DownloadResult failedReading(SessionLease lease, TransferWatch watch, IOException cause) {
        if (watch.fired().isPresent()) {
            return new DownloadResult.Failed(watch.fired().orElseThrow());
        }
        return switch (classifier.verdict(cause, SftpFailureClassifier.Site.TARGET_FILE)) {
            case SftpFailureClassifier.Verdict.Lost lost -> {
                lease.discard();
                yield new DownloadResult.Failed(TransferFailureCause.TRANSPORT_LOST);
            }
            case SftpFailureClassifier.Verdict.Refusal refusal -> new DownloadResult.Refused(refusal.code(), refusal.diagnostic());
        };
    }

    private DownloadResult changed() {
        return new DownloadResult.Refused(TransferErrorCode.FILE_CHANGED, new FileDiagnostic.None());
    }
}
