package io.github.jaeseongs95.portal.app.execution;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import tools.jackson.databind.json.JsonMapper;

import io.github.jaeseongs95.portal.app.output.OutputFormats;
import io.github.jaeseongs95.portal.app.output.OutputId;
import io.github.jaeseongs95.portal.app.output.OutputManifestStore;
import io.github.jaeseongs95.portal.app.output.OutputPayloadStore;
import io.github.jaeseongs95.portal.app.output.StreamFrame;
import io.github.jaeseongs95.portal.app.output.StreamInfo;
import io.github.jaeseongs95.portal.app.remote.OutputSink;
import io.github.jaeseongs95.portal.app.remote.SinkResult;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.error.ExecutionStage;
import io.github.jaeseongs95.portal.domain.error.RemoteOutcome;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.operation.CaptureState;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.OutputState;
import io.github.jaeseongs95.portal.domain.operation.StreamCapture;
import io.github.jaeseongs95.portal.domain.operation.Truncation;
import io.github.jaeseongs95.portal.domain.redact.OutputRedactor;

/**
 * The output of one running command (stage 3 design 3.4). It is the {@link OutputSink} the adapter writes to: every frame goes, as the raw bytes, to the private spool of
 * the output payload store, and is kept in memory, bounded by the output cap of the execution (two streams of at most the cap, so about 2 MiB by default). When the
 * execution has ended, {@link #finish} redacts each stream <em>once as a whole</em>, writes the two renderings (JSON and text) and marks the output ready. Nothing
 * outside this class sees the raw bytes, and the adapter neither redacts nor decodes.
 *
 * <p>A failure while the output is finished never reaches the caller: the command already ran, so a throw would hide its result. The output becomes unavailable and the
 * outcome says the capture failed (2.x {@code finish}: "never throw a capture error across an already executed SSH effect"). The one object serves one execution
 * and is used by the thread of that execution and the thread that reads the channel, so its methods are synchronized.
 */
public final class OpenOutput implements OutputSink {

    private static final Logger LOG = LoggerFactory.getLogger(OpenOutput.class);
    private static final Duration RETENTION = Duration.ofHours(1);

    private final OutputId id;
    private final long reservedBytes;
    private final OutputPayloadStore payloads;
    private final OutputManifestStore manifests;
    private final OutputRedactor redactor;
    private final JsonMapper json;
    private final Digester digester;
    private final Clock clock;
    private final ByteArrayOutputStream stdout = new ByteArrayOutputStream();
    private final ByteArrayOutputStream stderr = new ByteArrayOutputStream();
    private final ByteArrayOutputStream arrival = new ByteArrayOutputStream();

    OpenOutput(OutputId id, long reservedBytes, OutputPayloadStore payloads, OutputManifestStore manifests, OutputRedactor redactor, JsonMapper json, Digester digester,
               Clock clock) {
        this.id = id;
        this.reservedBytes = reservedBytes;
        this.payloads = payloads;
        this.manifests = manifests;
        this.redactor = redactor;
        this.json = json;
        this.digester = digester;
        this.clock = clock;
    }

    @Override
    public synchronized SinkResult accept(StreamFrame frame) {
        byte[] data = frame.data();
        switch (frame.kind()) {
            case STDOUT -> stdout.writeBytes(data);
            case STDERR -> stderr.writeBytes(data);
        }
        arrival.writeBytes(data);
        try {
            payloads.append(id, frame);
            return new SinkResult.Accepted();
        } catch (RuntimeException e) {
            LOG.error("A frame of the output could not be spooled", e);
            return new SinkResult.Failed(e);
        }
    }

    /**
     * Renders and stores the output and returns the outcome: the same one when it worked, with the capture marked failed when it did not.
     */
    public synchronized ExecutionOutcome finish(ExecutionOutcome outcome) {
        try {
            String out = redactor.redact(new String(stdout.toByteArray(), StandardCharsets.UTF_8)).value();
            String err = redactor.redact(new String(stderr.toByteArray(), StandardCharsets.UTF_8)).value();
            byte[] jsonBytes = json.writeValueAsBytes(new OutputDocument(out, err));
            byte[] textBytes = (err.isEmpty() ? out : out + "\n" + err).getBytes(StandardCharsets.UTF_8);
            long size = (long) jsonBytes.length + textBytes.length;
            if (size > reservedBytes) {
                throw new IllegalStateException("The rendering of the output is larger than its reservation");
            }
            manifests.recordStream(id, completeStream(outcome));
            OutputFormats formats = payloads.finish(id, jsonBytes, textBytes);
            manifests.markReady(id, formats, size);
            return outcome;
        } catch (RuntimeException e) {
            LOG.error("The output of an executed command could not be stored; it is unavailable", e);
            abandon();
            return captureFailed(outcome);
        }
    }

    /** Gives the output up (the command was not run, or its output cannot be kept): it becomes unavailable and keeps its charge until it expires. */
    public synchronized void abandon() {
        try {
            manifests.markUnavailable(id, clock.instant().plus(RETENTION));
        } catch (RuntimeException e) {
            LOG.error("An unused output could not be marked unavailable", e);
        }
    }

    private StreamInfo.CompleteStream completeStream(ExecutionOutcome outcome) {
        byte[] raw = arrival.toByteArray();
        boolean truncated = isTruncated(outcome.stdout()) || isTruncated(outcome.stderr());
        return new StreamInfo.CompleteStream(raw.length, raw.length, digester.digest(raw), cursorOf(outcome.stdout(), stdout.size()), cursorOf(outcome.stderr(), stderr.size()),
            truncated ? StreamInfo.Truncation.TRUNCATED : StreamInfo.Truncation.COMPLETE);
    }

    private static boolean isTruncated(StreamCapture capture) {
        return capture instanceof StreamCapture.Captured captured && captured.truncation() == Truncation.TRUNCATED;
    }

    private static long cursorOf(StreamCapture capture, long fallback) {
        return capture instanceof StreamCapture.Captured captured ? captured.cursor() : fallback;
    }

    private static ExecutionOutcome captureFailed(ExecutionOutcome outcome) {
        ExecutionFailure failure = outcome.failure();
        if (failure instanceof ExecutionFailure.Unclassified) {
            RemoteOutcome remote = switch (outcome.remoteState()) {
                case NOT_DISPATCHED -> RemoteOutcome.NOT_STARTED;
                case EXITED -> RemoteOutcome.COMPLETED;
                case UNKNOWN -> RemoteOutcome.UNKNOWN;
            };
            failure = new ExecutionFailure.Classified(ExecutionStage.OUTPUT_CAPTURE, ExecutionErrorCode.OUTPUT_CAPTURE_FAILED, remote);
        }
        return new ExecutionOutcome(outcome.reason(), outcome.remoteState(), outcome.exit(), outcome.signalDelivery(), outcome.cleanup(), outcome.reconciliation(),
            OutputState.PARTIAL, CaptureState.FAILED, outcome.timeout(), outcome.stdout(), outcome.stderr(), failure, outcome.failed(), outcome.texts(), outcome.evidence());
    }
}
