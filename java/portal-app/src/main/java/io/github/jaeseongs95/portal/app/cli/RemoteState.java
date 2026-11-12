package io.github.jaeseongs95.portal.app.cli;

/** The remote installation state an agent CLI request reports (2.x {@code agent-cli-state.mjs:51-58}). */
public enum RemoteState {
    NOT_FOUND, UNKNOWN, PREPARING, INSTALLING, COMPLETED, REUSED, FAILED
}
