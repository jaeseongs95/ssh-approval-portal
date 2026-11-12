package io.github.jaeseongs95.portal.app.remote;

/**
 * File work on a target over SFTP. The results are sealed and tell a confirmed refusal (the target is unchanged) from an outcome that is not known. Nothing here
 * throws for something that happens on the network or on the target: the one exception is {@code DispatchRefusedException} from the {@link DispatchGuard}, thrown
 * before the first write. Nothing here is sent twice.
 */
public interface RemoteFileTransfer {

    /** Publishes the bytes of {@code source} at the path of the request: a temporary file, verified, then put in place; the original is kept until the replacement is confirmed. */
    UploadResult upload(UploadRequest request, PayloadSource source, ExecutionControl control);

    /** Reads the file of the request into {@code sink}. It changes nothing on the target. */
    DownloadResult download(DownloadRequest request, PayloadSink sink, ExecutionControl control);

    /** Sets the permission bits; a target that cannot answers {@link PermissionResult.Unsupported} without calling SFTP. */
    PermissionResult applyPermissions(PermissionRequest request, ExecutionControl control);

    /** Runs the probe of the plan and says whether elevated file work is allowed. */
    ElevationResult checkElevation(ElevationRequest request, ExecutionControl control);
}
