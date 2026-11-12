package io.github.jaeseongs95.portal.app.remote;

import io.github.jaeseongs95.portal.app.output.StreamFrame;

/**
 * Where the adapter hands the output of a running command, frame by frame, in the order it arrives. The use case implements it over the output payload store (the
 * raw bytes are spooled; redaction is applied once to the whole text when the public rendering is made, not here). The adapter does not redact and does not decode.
 */
public interface OutputSink {

    /** Takes a frame; {@link SinkResult.Failed} means the frame was lost and the output is partial from here on. */
    SinkResult accept(StreamFrame frame);
}
