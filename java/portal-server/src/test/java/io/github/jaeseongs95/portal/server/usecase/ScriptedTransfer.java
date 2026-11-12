package io.github.jaeseongs95.portal.server.usecase;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.channels.Channels;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

import io.github.jaeseongs95.portal.app.remote.DownloadRequest;
import io.github.jaeseongs95.portal.app.remote.DownloadResult;
import io.github.jaeseongs95.portal.app.remote.ElevationRequest;
import io.github.jaeseongs95.portal.app.remote.ElevationResult;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.FileDiagnostic;
import io.github.jaeseongs95.portal.app.remote.PayloadSink;
import io.github.jaeseongs95.portal.app.remote.PayloadSource;
import io.github.jaeseongs95.portal.app.remote.PermissionRequest;
import io.github.jaeseongs95.portal.app.remote.PermissionResult;
import io.github.jaeseongs95.portal.app.remote.RemoteFileTransfer;
import io.github.jaeseongs95.portal.app.remote.ReplaceMethod;
import io.github.jaeseongs95.portal.app.remote.RestoreEvidence;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.app.remote.UnconfirmedCause;
import io.github.jaeseongs95.portal.app.remote.UploadRequest;
import io.github.jaeseongs95.portal.app.remote.UploadResult;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;

/**
 * The SFTP boundary of the use case tests, the other thing that is not real: a {@link RemoteFileTransfer} that answers what the test says and counts what it did. It
 * follows the contract of the real adapter in what the use cases depend on: it calls the guard once before it "writes", it reads the bytes of an upload from the source
 * the use case gave it, and it writes the bytes of a download to the sink the use case gave it. The counters rise only after the guard passed.
 */
final class ScriptedTransfer implements RemoteFileTransfer {

    /** What the transfer answers to an upload. */
    @FunctionalInterface
    interface UploadBehavior {

        UploadResult run(UploadRequest request);
    }

    /** What the transfer answers to a download; it may write to the sink first. */
    @FunctionalInterface
    interface DownloadBehavior {

        DownloadResult run(DownloadRequest request, PayloadSink sink);
    }

    private final AtomicInteger uploadsSent = new AtomicInteger();
    private final AtomicInteger downloadsSent = new AtomicInteger();
    private final List<byte[]> uploaded = new CopyOnWriteArrayList<>();
    private volatile UploadBehavior upload = publishes();
    private volatile DownloadBehavior download = disconnects();

    @Override
    public UploadResult upload(UploadRequest request, PayloadSource source, ExecutionControl control) {
        control.guard().beforeDispatch();
        uploadsSent.incrementAndGet();
        try (PayloadRead read = source.open()) {
            uploaded.add(Channels.newInputStream(read.channel()).readAllBytes());
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return upload.run(request);
    }

    @Override
    public DownloadResult download(DownloadRequest request, PayloadSink sink, ExecutionControl control) {
        control.guard().beforeDispatch();
        downloadsSent.incrementAndGet();
        return download.run(request, sink);
    }

    @Override
    public PermissionResult applyPermissions(PermissionRequest request, ExecutionControl control) {
        throw new IllegalStateException("The use case tests ask for no permission bits");
    }

    @Override
    public ElevationResult checkElevation(ElevationRequest request, ExecutionControl control) {
        throw new IllegalStateException("The use case tests ask for no elevation");
    }

    void reset() {
        uploadsSent.set(0);
        downloadsSent.set(0);
        uploaded.clear();
        upload = publishes();
        download = disconnects();
    }

    void onUpload(UploadBehavior behavior) {
        upload = behavior;
    }

    void onDownload(DownloadBehavior behavior) {
        download = behavior;
    }

    int uploadsSent() {
        return uploadsSent.get();
    }

    int downloadsSent() {
        return downloadsSent.get();
    }

    /** The bytes the use case sent in each upload, in order. */
    List<byte[]> uploaded() {
        return List.copyOf(uploaded);
    }

    /** The replacement is in place and confirmed, with the digest the owner approved. */
    UploadBehavior publishes() {
        return request -> new UploadResult.Published(request.sha256(), Instant.now(), ReplaceMethod.POSIX_RENAME);
    }

    /** The replacement is in place and confirmed, but the content has another digest than the one the owner approved. */
    UploadBehavior publishesAnotherDigest() {
        return request -> new UploadResult.Published(new Digest("f".repeat(64)), Instant.now(), ReplaceMethod.POSIX_RENAME);
    }

    /** The replacement happened and then failed, and the original is confirmed back in place. */
    UploadBehavior rollsBack() {
        return request -> new UploadResult.RolledBack(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.SftpStatus(3), new RestoreEvidence(Instant.now()));
    }

    /** The replacement failed and the original could not be confirmed back in place. */
    UploadBehavior losesTheOriginal() {
        return request -> new UploadResult.Unconfirmed(new UnconfirmedCause.RestoreUnconfirmed(".ssh-approval-bak-1"), CleanupState.COMPLETE);
    }

    /** The file is read to the end into the sink and confirmed. */
    DownloadBehavior fetches(byte[] content) {
        return (request, sink) -> {
            sink.append(content);
            return new DownloadResult.Fetched(content.length, new Sha256Digester().digest(content));
        };
    }

    /** The connection is lost while the file is read. */
    DownloadBehavior disconnects() {
        return (request, sink) -> new DownloadResult.Failed(TransferFailureCause.TRANSPORT_LOST);
    }
}
