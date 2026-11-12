package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * How an execution ended (public-contract.mjs:24-33, {@code executionData}). Every component may be null: a null component is the wire null (null = wire null) and
 * means the portal has no value for it. 2.x replaced a field that failed its own schema by null when it presented the data; 3.0 checks each value once, when the
 * record is built.
 *
 * <p>{@code automaticReplay} is the contract's promise that the portal never replays a command by itself: it is {@code false} or null, never {@code true}.
 * {@code exitCode} may be negative, {@code timeoutMs} is positive.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record ExecutionData(ExecutionPhaseWire phase, ExecutionReasonWire reason, RemoteStateWire remoteState, Long exitCode, String signal, Boolean automaticReplay,
                            SignalDeliveryWire signalDelivery, Long timeoutMs, Boolean cleanupComplete, Boolean requiresReconciliation, OutputStateWire outputState,
                            Boolean captureFailed, StreamMetadata stdout, StreamMetadata stderr) {

    public ExecutionData {
        WireNumber.SIGNED.requireOrNull(exitCode, "exitCode");
        if (signal != null) {
            WireFormat.SIGNAL.require(signal, "signal");
        }
        if (Boolean.TRUE.equals(automaticReplay)) {
            throw new IllegalArgumentException("automaticReplay is false or null: the portal never replays a command by itself");
        }
        WireNumber.POSITIVE.requireOrNull(timeoutMs, "timeoutMs");
    }
}
