package io.github.jaeseongs95.portal.ssh.exec;

import io.github.jaeseongs95.portal.app.output.StreamFrame;
import io.github.jaeseongs95.portal.app.output.StreamKind;
import io.github.jaeseongs95.portal.app.remote.OutputSink;
import io.github.jaeseongs95.portal.app.remote.SinkResult;
import io.github.jaeseongs95.portal.domain.operation.StreamCapture;
import io.github.jaeseongs95.portal.domain.operation.Truncation;
import java.io.IOException;
import java.io.InputStream;
import java.util.Arrays;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.core.task.TaskExecutor;

/**
 * Empties one output stream of a channel into the {@link OutputSink} (stage 3 design 3.4, defects D-0040 and D-0012's output cap). It reads the <em>inverted</em> stream of
 * the channel ({@code getInvertedOut}, {@code getInvertedErr}) on a thread of the injected executor, so a slow sink slows only this pump and never MINA's I/O thread; MINA
 * gives the window back as the bytes are read.
 *
 * <ul>
 * <li>The cap is per stream: the first {@code cap} bytes go to the sink, the rest are counted and dropped, and the capture says it was truncated.</li>
 * <li>A sink that answers {@link SinkResult.Failed} (or throws) loses its frame and every later one, but the pump keeps reading until the stream ends, so the channel is
 * emptied, released, and the next command on the session is not blocked. The capture is then reported as failed.</li>
 * <li>The bytes are not decoded: a multibyte character cut by a frame boundary reaches the sink as the bytes it was (the sink and the renderer decode, case S3-EX-13).</li>
 * </ul>
 */
final class OutputPump {

    private static final int FRAME_BYTES = 8192;

    private final StreamKind kind;
    private final InputStream stream;
    private final OutputSink sink;
    private final long cap;
    private final CompletableFuture<Void> done = new CompletableFuture<>();
    private final AtomicLong received = new AtomicLong();
    private final AtomicLong retained = new AtomicLong();
    private final AtomicBoolean sinkFailed = new AtomicBoolean();

    OutputPump(StreamKind kind, InputStream stream, OutputSink sink, long cap) {
        this.kind = kind;
        this.stream = stream;
        this.sink = sink;
        this.cap = cap;
    }

    /** Starts reading on the executor; the returned future completes when the stream has ended (or failed), whatever the sink did. */
    CompletableFuture<Void> start(TaskExecutor executor) {
        try {
            executor.execute(this::pump);
        } catch (RuntimeException e) {
            done.complete(null);
        }
        return done;
    }

    /** Completes when the stream has ended. */
    CompletableFuture<Void> done() {
        return done;
    }

    /** True when the sink lost a frame. */
    boolean sinkFailed() {
        return sinkFailed.get();
    }

    /** What was captured so far: the bytes received, the bytes the sink took, and whether the cap cut the stream. */
    StreamCapture capture() {
        long total = received.get();
        long kept = retained.get();
        Truncation truncation = !sinkFailed.get() && total > kept ? Truncation.TRUNCATED : Truncation.COMPLETE;
        return new StreamCapture.Captured(total, kept, kept, truncation);
    }

    private void pump() {
        byte[] buffer = new byte[FRAME_BYTES];
        try {
            while (true) {
                int count = stream.read(buffer);
                if (count < 0) {
                    break;
                }
                if (count > 0) {
                    take(buffer, count);
                }
            }
        } catch (IOException e) {
            // The channel ended abnormally: what was read is what there is; the supervisor decides what the end means.
        } finally {
            done.complete(null);
        }
    }

    private void take(byte[] buffer, int count) {
        received.addAndGet(count);
        if (sinkFailed.get()) {
            return;
        }
        long room = cap - retained.get();
        int size = (int) Math.min(count, Math.max(room, 0));
        if (size <= 0) {
            return;
        }
        SinkResult result;
        try {
            result = sink.accept(new StreamFrame(kind, Arrays.copyOf(buffer, size)));
        } catch (RuntimeException e) {
            result = new SinkResult.Failed(e);
        }
        if (result instanceof SinkResult.Failed) {
            sinkFailed.set(true);
        } else {
            retained.addAndGet(size);
        }
    }
}
