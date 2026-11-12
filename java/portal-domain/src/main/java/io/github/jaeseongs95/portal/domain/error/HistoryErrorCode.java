package io.github.jaeseongs95.portal.domain.error;

/** Failures of the history query: range, fields, filter, cursor, size. */
public enum HistoryErrorCode implements ErrorCode {
    HISTORY_INVALID_RANGE, HISTORY_INVALID_FIELDS, HISTORY_INVALID_FILTER, HISTORY_SEARCH_TOO_LARGE, HISTORY_INVALID_CURSOR, HISTORY_AMBIGUOUS_REQUEST,
    HISTORY_ENTRY_CHANGED, HISTORY_METADATA_UNAVAILABLE, HISTORY_ENTRY_TOO_LARGE;

    /** A history query reads; it never starts anything. */
    @Override
    public ExecutionAttempt attemptByDefault() {
        return ExecutionAttempt.NOT_ATTEMPTED;
    }
}
