package io.github.jaeseongs95.portal.domain.operation;

/** Whether everything the execution opened (channels, temporary files, processes) is confirmed closed. An execution whose cleanup is incomplete is unknown. */
public enum CleanupState {
    COMPLETE, INCOMPLETE
}
