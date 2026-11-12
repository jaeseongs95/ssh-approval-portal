package io.github.jaeseongs95.portal.ssh.testkit;

import java.util.Objects;

/**
 * A failure the test server's SFTP subsystem injects. It applies to the server operation {@code operation} on a path that ends with {@code pathSuffix}
 * (separators are compared as {@code /}), the first {@code times} times it matches.
 *
 * <p>For {@link Operation#OPEN_FOR_READ} and {@link Operation#OPEN_FOR_WRITE}, {@code afterBytes == 0} fails the open itself; a larger value lets the open succeed
 * and fails the first read or write call made after at least that many bytes have moved through the handle (a "disk full" or "link lost" in the middle of a transfer).
 *
 * @param operation  the operation to fail
 * @param pathSuffix the end of the path the operation must touch (for a rename, the source or the target)
 * @param failure    what the client sees
 * @param afterBytes see above; 0 for the operations that have no transfer
 * @param times      how many matches fail; {@link Integer#MAX_VALUE} means every match until {@link EmbeddedSshServer#clearSftpFaults()}
 */
public record SftpFault(Operation operation, String pathSuffix, Failure failure, long afterBytes, int times) {

    /** The server operations a fault can hit. */
    public enum Operation {
        OPEN_FOR_READ, OPEN_FOR_WRITE, RENAME, REMOVE, MKDIR
    }

    /** What the client sees. */
    public enum Failure {
        /** {@code SSH_FX_PERMISSION_DENIED}, from an {@code AccessDeniedException} (what the file system says for EACCES). */
        PERMISSION_DENIED,
        /** {@code SSH_FX_NO_SPACE_ON_FILESYSTEM}: the server answers a "disk full" in the SFTP version that has the code (MINA negotiates 6; OpenSSH's sftp-server speaks 3). */
        NO_SPACE,
        /** {@code SSH_FX_FAILURE}, from a plain {@code IOException}. */
        IO_ERROR,
        /** The server closes the SSH session abruptly (no disconnect message) and the operation fails. */
        CONNECTION_DROPPED
    }

    public SftpFault {
        Objects.requireNonNull(operation, "operation");
        Objects.requireNonNull(pathSuffix, "pathSuffix");
        Objects.requireNonNull(failure, "failure");
        if (afterBytes < 0) {
            throw new IllegalArgumentException("afterBytes must not be negative: " + afterBytes);
        }
        if (times < 1) {
            throw new IllegalArgumentException("times must be at least 1: " + times);
        }
    }

    /** A fault that fails the operation itself, every time it matches. */
    public static SftpFault of(Operation operation, String pathSuffix, Failure failure) {
        return new SftpFault(operation, pathSuffix, failure, 0, Integer.MAX_VALUE);
    }

    /** The same fault, failing a transfer only after {@code bytes} bytes have moved. */
    public SftpFault afterBytes(long bytes) {
        return new SftpFault(operation, pathSuffix, failure, bytes, times);
    }

    /** The same fault, failing only the first {@code count} matches. */
    public SftpFault times(int count) {
        return new SftpFault(operation, pathSuffix, failure, afterBytes, count);
    }
}
