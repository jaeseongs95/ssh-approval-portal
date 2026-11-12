package io.github.jaeseongs95.portal.app.remote;

/**
 * The moments of one execution the adapter notes (stage 3 design 3.4, defect D-0038), in the order they normally happen. A phase that did not happen is simply not
 * in the timeline: a connection that failed has {@link #CONNECT_STARTED} and nothing after it.
 */
public enum ExecutionPhase {
    /** The adapter began to connect (or took a live session from the pool). */
    CONNECT_STARTED,
    /** The session is authenticated and ready. */
    CONNECTED,
    /** The server accepted the channel. */
    CHANNEL_OPENED,
    /** The {@code exec} request was written to the channel. */
    REQUEST_SENT,
    /** The first byte of output arrived. */
    FIRST_OUTPUT,
    /** The exit status or the exit signal arrived. */
    EXIT_SEEN,
    /** The channel was closed. */
    CLOSED
}
