package io.github.jaeseongs95.portal.ssh.testkit;

import io.github.jaeseongs95.portal.app.output.StreamFrame;
import io.github.jaeseongs95.portal.app.remote.OutputSink;
import io.github.jaeseongs95.portal.app.remote.SinkResult;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * An {@link OutputSink} for tests: it keeps what it was given, per stream, and it can be told to fail from a frame on ({@link #failingFromFrame(int)}, counted from 1) to
 * show that the adapter keeps emptying the channel after a failed sink. {@link #offeredFrames()} is an {@link EventLog}, so a test waits for the first frame without polling.
 */
public final class CollectingSink implements OutputSink {

    private final ByteArrayOutputStream stdout = new ByteArrayOutputStream();
    private final ByteArrayOutputStream stderr = new ByteArrayOutputStream();
    private final EventLog<StreamFrame> offered = new EventLog<>();
    private final int failFromFrame;

    private CollectingSink(int failFromFrame) {
        this.failFromFrame = failFromFrame;
    }

    /** A sink that takes every frame. */
    public static CollectingSink accepting() {
        return new CollectingSink(Integer.MAX_VALUE);
    }

    /** A sink that takes the frames before the {@code frame}-th one (counted from 1) and answers {@code Failed} to that one and every later one. */
    public static CollectingSink failingFromFrame(int frame) {
        return new CollectingSink(frame);
    }

    @Override
    public SinkResult accept(StreamFrame frame) {
        SinkResult result;
        synchronized (this) {
            int number = offered.size() + 1;
            if (number >= failFromFrame) {
                result = new SinkResult.Failed(new IllegalStateException("the test sink fails on purpose from frame " + failFromFrame));
            } else {
                byte[] data = frame.data();
                switch (frame.kind()) {
                    case STDOUT -> stdout.write(data, 0, data.length);
                    case STDERR -> stderr.write(data, 0, data.length);
                }
                result = new SinkResult.Accepted();
            }
            offered.add(frame);
        }
        return result;
    }

    /** Every frame the sink was offered (the failed ones included), in order. */
    public EventLog<StreamFrame> offeredFrames() {
        return offered;
    }

    /** The bytes of standard output the sink took. */
    public synchronized byte[] stdoutBytes() {
        return stdout.toByteArray();
    }

    /** The bytes of standard error the sink took. */
    public synchronized byte[] stderrBytes() {
        return stderr.toByteArray();
    }

    /** The standard output the sink took, decoded as UTF-8 in one piece (so a character cut between frames is whole). */
    public synchronized String stdout() {
        return new String(stdout.toByteArray(), StandardCharsets.UTF_8);
    }

    /** The standard error the sink took, decoded as UTF-8 in one piece. */
    public synchronized String stderr() {
        return new String(stderr.toByteArray(), StandardCharsets.UTF_8);
    }
}
