package io.github.jaeseongs95.portal.domain.contract;

import io.github.jaeseongs95.portal.domain.error.ErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionAttempt;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * The {@code error} object of a failed envelope: the code, whether a retry can help and what may have happened on the target (public-contract.mjs:73,
 * {@code errorData}). The wire code is the enum constant name, and every name must satisfy the contract pattern.
 */
public record ErrorData(ErrorCode code, boolean retryable, ExecutionAttempt executionAttempted) {

    /** The pattern of {@code error.code} in the contract (public-contract.mjs:73 and {@code envelope.schema.json}). */
    public static final Pattern CODE_PATTERN = Pattern.compile("^[A-Z][A-Z0-9_]{1,95}$");

    public ErrorData {
        Objects.requireNonNull(code, "code");
        Objects.requireNonNull(executionAttempted, "executionAttempted");
        if (!CODE_PATTERN.matcher(code.name()).matches()) {
            throw new IllegalArgumentException("Error code does not match the contract pattern: " + code.name());
        }
    }

    /** The error object of the refusal an exception carries. */
    public static ErrorData of(RequestRefusedException refusal) {
        return new ErrorData(refusal.code(), refusal.retryable(), refusal.attempt());
    }
}
