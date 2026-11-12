package io.github.jaeseongs95.portal.domain.operation;

/** Whether capturing the output worked. {@link #NOT_REPORTED} for an execution without output; the contract writes it as an absent value. */
public enum CaptureState {
    NOT_REPORTED, OK, FAILED
}
