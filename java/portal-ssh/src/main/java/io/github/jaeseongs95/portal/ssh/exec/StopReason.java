package io.github.jaeseongs95.portal.ssh.exec;

/** Why the supervisor began the stop procedure of an execution (stage 3 design 3.2, 3.3); {@link #NONE} while it has not. */
enum StopReason {
    NONE,
    /** The owner cancelled. */
    CANCEL,
    /** The time limit of the execution passed. */
    DEADLINE,
    /** Writing the standard input failed. */
    INPUT_FAILED,
    /** The reply to the exec request was awaited and did not come (decision D3-06: unknown, as if the transport were lost). */
    REPLY_TIMEOUT
}
