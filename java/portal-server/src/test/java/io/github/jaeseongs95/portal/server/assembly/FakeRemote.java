package io.github.jaeseongs95.portal.server.assembly;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.channels.Channels;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import io.github.jaeseongs95.portal.app.remote.DownloadRequest;
import io.github.jaeseongs95.portal.app.remote.DownloadResult;
import io.github.jaeseongs95.portal.app.remote.ElevationRequest;
import io.github.jaeseongs95.portal.app.remote.ElevationResult;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.PayloadSink;
import io.github.jaeseongs95.portal.app.remote.PayloadSource;
import io.github.jaeseongs95.portal.app.remote.PermissionRequest;
import io.github.jaeseongs95.portal.app.remote.PermissionResult;
import io.github.jaeseongs95.portal.app.remote.RemoteFileTransfer;
import io.github.jaeseongs95.portal.app.remote.ReplaceMethod;
import io.github.jaeseongs95.portal.app.remote.SinkResult;
import io.github.jaeseongs95.portal.app.remote.UploadRequest;
import io.github.jaeseongs95.portal.app.remote.UploadResult;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;

/**
 * The SSH boundary of the assembly tests: a plain class that stands where the MINA adapter of portal-ssh will stand. It reads the bytes of an upload from the source the way
 * the adapter does, and writes the bytes of a download to the sink in pieces; what it answers is what the test script says. It counts every call, so a test can show that a
 * refusal before dispatch sent nothing and that nothing is sent twice.
 */
final class FakeRemote implements RemoteFileTransfer {

    private static final int PIECE = 1000;

    private final Sha256Digester digester = new Sha256Digester();

    final List<UploadRequest> uploads = new ArrayList<>();
    final List<DownloadRequest> downloads = new ArrayList<>();
    final List<PermissionRequest> permissions = new ArrayList<>();
    byte[] uploaded = new byte[0];

    /** What the next upload answers; {@code null} answers {@code Published} with the digest of the bytes read. */
    UploadResult uploadAnswer;
    /** What the next download answers without reading; {@code null} serves {@link #served}. */
    DownloadResult downloadAnswer;
    byte[] served = new byte[0];
    /** True: the download says {@code Fetched} with a digest that is not the digest of what it wrote. */
    boolean lieAboutTheDigest;
    PermissionResult permissionAnswer = new PermissionResult.Applied();
    /** Thrown by the next download, as the {@code DispatchGuard} of the adapter throws before its first read. */
    RuntimeException downloadFailure;

    void reset() {
        downloadFailure = null;
        uploads.clear();
        downloads.clear();
        permissions.clear();
        uploaded = new byte[0];
        uploadAnswer = null;
        downloadAnswer = null;
        served = new byte[0];
        lieAboutTheDigest = false;
        permissionAnswer = new PermissionResult.Applied();
    }

    @Override
    public UploadResult upload(UploadRequest request, PayloadSource source, ExecutionControl control) {
        uploads.add(request);
        try (PayloadRead read = source.open()) {
            uploaded = Channels.newInputStream(read.channel()).readAllBytes();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        if (uploadAnswer != null) {
            return uploadAnswer;
        }
        return new UploadResult.Published(digester.digest(uploaded), Instant.parse("2026-11-12T00:00:00Z"), ReplaceMethod.POSIX_RENAME);
    }

    @Override
    public DownloadResult download(DownloadRequest request, PayloadSink sink, ExecutionControl control) {
        downloads.add(request);
        if (downloadFailure != null) {
            throw downloadFailure;
        }
        if (downloadAnswer != null) {
            return downloadAnswer;
        }
        for (int from = 0; from < served.length; from += PIECE) {
            byte[] piece = java.util.Arrays.copyOfRange(served, from, Math.min(served.length, from + PIECE));
            if (sink.append(piece) instanceof SinkResult.Failed) {
                return new DownloadResult.Failed(io.github.jaeseongs95.portal.app.remote.TransferFailureCause.LOCAL_IO_FAILED);
            }
        }
        Digest digest = lieAboutTheDigest ? digester.digest(new byte[] {1, 2, 3}) : digester.digest(served);
        return new DownloadResult.Fetched(served.length, digest);
    }

    @Override
    public PermissionResult applyPermissions(PermissionRequest request, ExecutionControl control) {
        permissions.add(request);
        return permissionAnswer;
    }

    @Override
    public ElevationResult checkElevation(ElevationRequest request, ExecutionControl control) {
        throw new IllegalStateException("The file use cases do not check elevation");
    }
}
