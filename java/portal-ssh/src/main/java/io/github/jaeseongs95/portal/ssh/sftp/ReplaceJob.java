package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import java.util.Objects;
import org.apache.sshd.sftp.client.SftpClient;

/**
 * Everything {@link AtomicReplacer} needs to put a verified temporary file in place of the target: the client, where the file is, the name of the temporary file (next
 * to the target, written and verified already), how the target looked when the transfer began, what to do when it exists, and what the finished file must be.
 *
 * @param client the SFTP client of the session
 * @param location the path of the target
 * @param tempName the file name of the temporary file in the target's directory
 * @param original how the target looked before the transfer: {@link PathInspection.Absent} or {@link PathInspection.Present}
 * @param overwrite whether an existing target may be replaced
 * @param expectedSize the size the finished file must have
 * @param expectedSha256 the digest of the content that was written and verified in the temporary file
 */
record ReplaceJob(SftpClient client, SftpLocation location, String tempName, PathInspection original, OverwriteMode overwrite, long expectedSize,
                  Digest expectedSha256) {

    ReplaceJob {
        Objects.requireNonNull(client, "client");
        Objects.requireNonNull(location, "location");
        Objects.requireNonNull(tempName, "tempName");
        Objects.requireNonNull(original, "original");
        Objects.requireNonNull(overwrite, "overwrite");
        Objects.requireNonNull(expectedSha256, "expectedSha256");
        if (!(original instanceof PathInspection.Absent) && !(original instanceof PathInspection.Present)) {
            throw new IllegalArgumentException("The original is a file that exists or one that does not");
        }
        if (expectedSize < 0) {
            throw new IllegalArgumentException("expectedSize must not be negative");
        }
    }

    /** The SFTP path of the temporary file. */
    String tempPath() {
        return location.sibling(tempName);
    }
}
