package io.github.jaeseongs95.portal.app.execution;

import java.time.Clock;

import org.springframework.stereotype.Component;

import tools.jackson.databind.json.JsonMapper;

import io.github.jaeseongs95.portal.app.output.OutputBinding;
import io.github.jaeseongs95.portal.app.output.OutputManifestStore;
import io.github.jaeseongs95.portal.app.output.OutputPayloadStore;
import io.github.jaeseongs95.portal.app.output.OutputReservation;
import io.github.jaeseongs95.portal.app.output.OutputTarget;
import io.github.jaeseongs95.portal.app.remote.ExecutionLimits;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.error.ExecutionStage;
import io.github.jaeseongs95.portal.domain.error.RemoteOutcome;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.redact.OutputRedactor;

/**
 * Reserves the output of a command before the command starts, so a command whose output cannot be kept is refused while nothing has been sent (2.x {@code reserve}). The
 * reservation covers both streams at the cap of the execution and the two renderings of the finished output. The reasons of a refusal stay apart: the size of one output
 * and the count of outputs are {@code OUTPUT_CAPACITY}, the byte budget is {@code ARTIFACT_QUOTA}, a disk without room is {@code ARTIFACT_STORAGE_FULL} (defect
 * D-0012; decision D3-03).
 */
@Component
public class CommandOutputWriter {

    /** The room for the JSON and the text renderings on top of the raw streams: 256 KiB. */
    private static final long RENDERING_ROOM = 256L * 1024;

    private final OutputManifestStore manifests;
    private final OutputPayloadStore payloads;
    private final OutputRedactor redactor;
    private final JsonMapper json;
    private final Digester digester;
    private final Clock clock;

    public CommandOutputWriter(OutputManifestStore manifests, OutputPayloadStore payloads, OutputRedactor redactor, JsonMapper json, Digester digester, Clock clock) {
        this.manifests = manifests;
        this.payloads = payloads;
        this.redactor = redactor;
        this.json = json;
        this.digester = digester;
        this.clock = clock;
    }

    /** Reserves the output of the operation's command under the limits of the execution. */
    public OutputOpening open(Operation operation, ExecutionLimits limits) {
        long reserved = 2 * limits.outputPerStream().toBytes() + RENDERING_ROOM;
        OutputBinding binding = new OutputBinding(operation.id(), new OutputTarget.Bound(operation.targetId(), operation.targetRevision()));
        return switch (manifests.reserve(binding, reserved, clock.instant())) {
            case OutputReservation.Reserved ok -> new OutputOpening.Opened(new OpenOutput(ok.id(), reserved, payloads, manifests, redactor, json, digester, clock));
            case OutputReservation.TooLarge tooLarge -> refused(ExecutionErrorCode.OUTPUT_CAPACITY);
            case OutputReservation.CountExceeded countExceeded -> refused(ExecutionErrorCode.OUTPUT_CAPACITY);
            case OutputReservation.BudgetExceeded budgetExceeded -> refused(ExecutionErrorCode.ARTIFACT_QUOTA);
            case OutputReservation.DiskSpaceInsufficient diskFull -> refused(ExecutionErrorCode.ARTIFACT_STORAGE_FULL);
        };
    }

    private OutputOpening refused(ExecutionErrorCode code) {
        return new OutputOpening.Refused(new ExecutionFailure.Classified(ExecutionStage.OUTPUT_RESERVATION, code, RemoteOutcome.NOT_STARTED));
    }
}
