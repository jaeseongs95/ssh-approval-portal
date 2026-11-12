package io.github.jaeseongs95.portal.domain.operation;

/** Whether a file or script operation runs with elevated rights on the target. Elevation is never implied; the caller asks for it explicitly. */
public enum Elevation {
    NONE, SUDO
}
