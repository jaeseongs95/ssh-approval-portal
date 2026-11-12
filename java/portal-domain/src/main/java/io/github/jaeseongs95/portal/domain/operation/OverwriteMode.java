package io.github.jaeseongs95.portal.domain.operation;

/** What an upload does when the remote file exists: replace it, or fail. */
public enum OverwriteMode {
    REPLACE, FAIL_IF_EXISTS
}
