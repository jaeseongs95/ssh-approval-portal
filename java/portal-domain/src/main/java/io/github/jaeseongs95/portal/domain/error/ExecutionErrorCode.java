package io.github.jaeseongs95.portal.domain.error;

/**
 * The codes an execution failure diagnostic may carry (execution-failure.mjs:4). {@link #ARTIFACT_STORAGE_FULL} is the code of a disk that cannot take the bytes of a
 * reservation (stage 3 design, decision D3-03); it lives here and not in {@link ArtifactErrorCode} because a wire code belongs to exactly one category, and the
 * download of a file is an execution that has to name it, as it names {@link #ARTIFACT_QUOTA} for the byte budget.
 */
public enum ExecutionErrorCode implements ErrorCode {
    SSH_CONNECT_FAILED, SSH_CHANNEL_OPEN_FAILED, SSH_EXECUTION_FAILED, OUTPUT_CAPACITY, OUTPUT_CAPTURE_FAILED, OPERATION_FAILED, ARTIFACT_QUOTA, ARTIFACT_STORAGE_FULL;

    /**
     * The two refusals of the byte reservation are answered before anything is sent to the target (2.x transferRefusals rows carry {@code executionAttempted: false});
     * every other code of this category describes a step after the effect may have started.
     */
    @Override
    public ExecutionAttempt attemptByDefault() {
        return this == ARTIFACT_QUOTA || this == ARTIFACT_STORAGE_FULL ? ExecutionAttempt.NOT_ATTEMPTED : ExecutionAttempt.UNKNOWN;
    }
}
