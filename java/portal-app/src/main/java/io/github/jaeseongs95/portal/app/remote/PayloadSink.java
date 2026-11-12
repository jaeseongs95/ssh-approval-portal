package io.github.jaeseongs95.portal.app.remote;

/**
 * Where a download puts the bytes it reads, in order (the use case appends them to the artifact payload; the adapter only reads and forwards). A sink that fails
 * answers {@link SinkResult.Failed}; the adapter stops reading and answers {@code DownloadResult.Failed(LOCAL_IO_FAILED)}, and the use case, which owns the sink,
 * knows the cause.
 */
public interface PayloadSink {

    SinkResult append(byte[] data);
}
