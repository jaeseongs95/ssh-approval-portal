package io.github.jaeseongs95.portal.domain.contract;

/** The codes an execution failure diagnostic may carry (execution-failure.mjs:4). */
public enum ExecutionErrorCode implements ErrorCode {
    SSH_CONNECT_FAILED, SSH_CHANNEL_OPEN_FAILED, SSH_EXECUTION_FAILED, OUTPUT_CAPACITY, OUTPUT_CAPTURE_FAILED, OPERATION_FAILED, ARTIFACT_QUOTA
}
