package io.github.jaeseongs95.portal.ssh.sftp;

/**
 * What an SFTP server's answer to one request means, before it is turned into the code of a file transfer (stage 3 design 4.5). The kinds do not mix: a server
 * that refuses (permission denied, no such file, already exists, no space) is a confirmed answer about the target, a lost connection is not an answer at all, and a
 * plain {@code FAILURE} says only that the server did not do it. Keeping them apart is what defect D-0013 asks for: a refusal must never read as a transport error
 * and a transport error must never read as a refusal.
 *
 * @param kind what the answer means
 * @param status the SFTP status code of the answer, or {@link #NO_STATUS} when the failure did not come as a status (a closed channel, a dead session)
 */
public record SftpFailure(Kind kind, int status) {

    /** The status of a failure that did not come from the server's status message. */
    public static final int NO_STATUS = -1;

    /** The meaning of an SFTP failure. */
    public enum Kind {
        /** {@code SSH_FX_NO_SUCH_FILE} (2) or {@code SSH_FX_NO_SUCH_PATH} (10). */
        NOT_FOUND,
        /** {@code SSH_FX_PERMISSION_DENIED} (3) or {@code SSH_FX_WRITE_PROTECT} (12). */
        PERMISSION_DENIED,
        /** {@code SSH_FX_FILE_ALREADY_EXISTS} (11). */
        ALREADY_EXISTS,
        /** {@code SSH_FX_NO_SPACE_ON_FILESYSTEM} (14) or {@code SSH_FX_QUOTA_EXCEEDED} (15). */
        NO_SPACE,
        /** {@code SSH_FX_FAILURE} (4): the server did not do it and does not say why; a space query may tell. */
        PLAIN_FAILURE,
        /** The path is not what a regular file path must be: a link loop, a directory where a file is, a file where a directory is. */
        NOT_A_REGULAR_PATH,
        /** {@code SSH_FX_NO_CONNECTION} (6), {@code SSH_FX_CONNECTION_LOST} (7), or no SFTP answer at all (the channel or the session closed). */
        TRANSPORT_LOST,
        /** Any other status: an operation the server does not know, a bad message, an invalid name. */
        OTHER
    }
}
