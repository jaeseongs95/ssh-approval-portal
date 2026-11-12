package io.github.jaeseongs95.portal.ssh.sftp;

import java.util.Objects;
import org.apache.sshd.sftp.client.SftpClient;
import org.apache.sshd.sftp.common.SftpConstants;

/**
 * What kind of file a server reports in the attributes of a {@code lstat}: a regular file, a directory, a link, or anything else (a FIFO, a device, a socket). SFTP
 * version 3 carries the kind in the file-type bits of the permissions and later versions in a type field of their own; both are read, so the answer does not depend on
 * the version the two sides negotiated. {@code lstat} does not follow links, so a link is reported as a link.
 */
enum FileKind {
    REGULAR, DIRECTORY, SYMBOLIC_LINK, OTHER;

    /** The kind the attributes report. */
    static FileKind of(SftpClient.Attributes attributes) {
        Objects.requireNonNull(attributes, "attributes");
        int type = attributes.getType();
        if (attributes.isSymbolicLink() || type == SftpConstants.SSH_FILEXFER_TYPE_SYMLINK) {
            return SYMBOLIC_LINK;
        }
        if (attributes.isDirectory() || type == SftpConstants.SSH_FILEXFER_TYPE_DIRECTORY) {
            return DIRECTORY;
        }
        if (attributes.isRegularFile() || type == SftpConstants.SSH_FILEXFER_TYPE_REGULAR) {
            return REGULAR;
        }
        return OTHER;
    }
}
