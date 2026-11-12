package io.github.jaeseongs95.portal.domain.target;

/** Whether the connection allocates a terminal. A Windows target and a source request need {@link #NO_TTY}. */
public enum TtyMode {
    TTY, NO_TTY
}
