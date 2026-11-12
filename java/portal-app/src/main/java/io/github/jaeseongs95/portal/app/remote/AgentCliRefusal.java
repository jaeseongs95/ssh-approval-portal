package io.github.jaeseongs95.portal.app.remote;

/**
 * Why an agent CLI installation was refused or failed at a confirmed point. All of them are shown to the owner as {@code INSTALL_FAILED}; the value picks the
 * sentence.
 */
public enum AgentCliRefusal {
    /** The downloaded package does not have the checksum the release announced; nothing was sent to the target. */
    PACKAGE_INTEGRITY_MISMATCH,
    /** The target lacks something the fixed commands need (for example a tool to unpack with). */
    PREREQUISITE_MISSING,
    /** A fixed command ended with a failure before the switch to the new version. */
    INSTALL_COMMAND_FAILED
}
