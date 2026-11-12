package io.github.jaeseongs95.portal.app.remote;

/** Starts a command with binary standard streams and no terminal (A-816 to A-829). Only the name and the signature are fixed in stage 3; the desktop module of stage 5 uses it. */
public interface RemoteStreamExecutor {

    StreamOpenResult open(StreamRequest request, ExecutionControl control);
}
