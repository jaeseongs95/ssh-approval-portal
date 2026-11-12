package io.github.jaeseongs95.portal.domain.target;

/** What a connection profile may do: only read (the profile a read-only command uses), or read and write. A target has one of each. */
public enum AccessMode {
    READ_ONLY, READ_WRITE
}
