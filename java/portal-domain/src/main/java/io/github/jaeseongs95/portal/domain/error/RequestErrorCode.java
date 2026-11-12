package io.github.jaeseongs95.portal.domain.error;

/** Request-level refusals: input the contract does not accept, a target or operation that is not there, a read command that cannot run, a maintenance window. */
public enum RequestErrorCode implements ErrorCode {
    OPERATION_INPUT_CONFLICT, OPERATION_INPUT_REQUIRED, OPERATION_NOT_FOUND, OPERATIONS_UNAVAILABLE, OPERATION_LOOKUP_REQUIRED, OPERATION_SELECTOR_REQUIRED,
    OUTPUT_READ_NOT_REQUESTED, OUTPUT_BINDING_CONFLICT, OPAQUE_FILES_UNAVAILABLE, FILE_ACTION_INPUT_CONFLICT, FILE_ACTION_INPUT_REQUIRED, REQUEST_REFUSED,
    INVALID_OPERATION_INPUT, OPERATION_KEY_CONFLICT, TARGET_REVISION_CONFLICT, TARGET_UNAVAILABLE, TARGET_CAPABILITY_UNSUPPORTED, OPERATION_ACCEPTANCE_NOT_CONFIRMED,
    INVALID_COMMAND_CONTEXT, COMMAND_CONTEXT_TOO_LARGE, COMMAND_CONTEXT_CONTAINS_SECRET, SOURCE_CREDENTIAL_MATERIAL, SOURCE_ARGUMENTS_SENSITIVE,
    SOURCE_WORKDIR_SENSITIVE, READ_COMMAND_BUSY, READ_COMMAND_REQUIRES_APPROVAL, READ_COMMAND_NOT_STARTED, READ_COMMAND_EXECUTION_UNKNOWN, MAINTENANCE,
    MAINTENANCE_ACTIVE;

    @Override
    public boolean retryableByDefault() {
        return this == MAINTENANCE_ACTIVE;
    }

    /** A request is refused before anything runs, except the two codes that say a start was attempted or its acceptance is unconfirmed (results.mjs:118-121). */
    @Override
    public ExecutionAttempt attemptByDefault() {
        if (this == READ_COMMAND_EXECUTION_UNKNOWN) {
            return ExecutionAttempt.ATTEMPTED;
        }
        return this == OPERATION_ACCEPTANCE_NOT_CONFIRMED ? ExecutionAttempt.UNKNOWN : ExecutionAttempt.NOT_ATTEMPTED;
    }
}
