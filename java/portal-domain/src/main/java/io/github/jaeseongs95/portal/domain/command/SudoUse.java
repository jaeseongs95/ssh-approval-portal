package io.github.jaeseongs95.portal.domain.command;

/** Whether a command line runs something through {@code sudo}. A PowerShell grammar always answers {@link #NO_SUDO}. */
public enum SudoUse {
    USES_SUDO,
    NO_SUDO
}
