package io.github.jaeseongs95.portal.app.remote;

/**
 * A closed fact about why a file operation was refused, beyond the error code. It holds no text of the server: an error message never becomes diagnostic data
 * (2.x {@code fileDiagnostic}, which kept only typed fields). The sentences shown to the owner come from the message bundle by code and variant.
 */
public sealed interface FileDiagnostic permits FileDiagnostic.None, FileDiagnostic.SftpStatus, FileDiagnostic.NoSpace {

    /** The code says it all. */
    record None() implements FileDiagnostic {
    }

    /**
     * The SFTP status code the server answered (for example 3 for permission denied, 4 for a plain failure).
     *
     * @param code the status code, not negative
     */
    record SftpStatus(int code) implements FileDiagnostic {

        public SftpStatus {
            if (code < 0) {
                throw new IllegalArgumentException("An SFTP status code is not negative");
            }
        }
    }

    /** The target's file system has no space left (SFTP status 14 or 15, or a failure the adapter confirmed with a space query). It is not a permission problem. */
    record NoSpace() implements FileDiagnostic {
    }
}
