package io.github.jaeseongs95.portal.app.remote;

/**
 * Why a remote request did not get to its effect, for the answers that have no refusal code of the target: nothing was written to the target (or, for a read, nothing
 * was changed) when one of these is the whole answer.
 */
public enum TransferFailureCause {
    /** The connection, authentication or host key failed ({@code SSH_CONNECT_FAILED}). */
    CONNECT_FAILED,
    /** The server refused to open the channel or the SFTP subsystem ({@code SSH_CHANNEL_OPEN_FAILED}). */
    CHANNEL_OPEN_FAILED,
    /** The connection was lost. */
    TRANSPORT_LOST,
    /** The time limit of the request was reached. */
    DEADLINE,
    /** The owner asked to stop. */
    CANCELLED,
    /** A local file or sink failed (the artifact store, the payload sink). */
    LOCAL_IO_FAILED
}
