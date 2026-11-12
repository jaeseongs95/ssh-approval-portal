package io.github.jaeseongs95.portal.domain.desktop;

/** Whether the operating-system session is locked. 2.x used {@code true}, {@code false} and {@code null}; a lock that could not be read is {@code UNKNOWN}. */
public enum LockState {
    LOCKED, UNLOCKED, UNKNOWN
}
