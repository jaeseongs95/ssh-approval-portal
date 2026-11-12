package io.github.jaeseongs95.portal.app.remote;

/** Whether the tool on the target holds a login, read from the existence of its credential file; the tool itself is never run to ask. */
public enum LoginState {
    SIGNED_IN, SIGNED_OUT, NOT_INSTALLED
}
