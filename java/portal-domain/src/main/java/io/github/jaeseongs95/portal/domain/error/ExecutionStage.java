package io.github.jaeseongs95.portal.domain.error;

import com.fasterxml.jackson.annotation.JsonValue;
import java.util.EnumSet;
import java.util.Locale;
import java.util.Set;

/**
 * The step of an execution at which it failed (2.x execution-failure.mjs:3). The wire value is the lowercase name. Every stage knows the error codes that
 * belong to it, so {@code SSH_CONNECT_FAILED} at the output capture stage is refused when an {@link ExecutionFailure} is built.
 */
public enum ExecutionStage {
    SSH_CONNECT(ExecutionErrorCode.SSH_CONNECT_FAILED),
    SSH_CHANNEL(ExecutionErrorCode.SSH_CHANNEL_OPEN_FAILED),
    SSH_EXECUTION(ExecutionErrorCode.SSH_EXECUTION_FAILED),
    OUTPUT_RESERVATION(ExecutionErrorCode.OUTPUT_CAPACITY, ExecutionErrorCode.ARTIFACT_QUOTA, ExecutionErrorCode.ARTIFACT_STORAGE_FULL),
    OUTPUT_CAPTURE(ExecutionErrorCode.OUTPUT_CAPTURE_FAILED),
    OPERATION(ExecutionErrorCode.OPERATION_FAILED, ExecutionErrorCode.ARTIFACT_QUOTA, ExecutionErrorCode.ARTIFACT_STORAGE_FULL);

    private final Set<ExecutionErrorCode> codes;

    ExecutionStage(ExecutionErrorCode first, ExecutionErrorCode... more) {
        this.codes = EnumSet.of(first, more);
    }

    /** True when the error code can be raised at this stage. */
    public boolean accepts(ExecutionErrorCode code) {
        return codes.contains(code);
    }

    @JsonValue
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }
}
