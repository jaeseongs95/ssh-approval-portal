package io.github.jaeseongs95.portal.ssh.sftp;

import java.nio.file.attribute.FileTime;
import java.util.Objects;
import org.apache.sshd.sftp.client.SftpClient;

/**
 * What the server reported about a regular file the moment the adapter looked: its size, its modification time and its permission bits. Two looks at the same file are
 * compared before a replacement and after a read; a difference means the file changed under the transfer (2.x compared the device, the inode and the change time as well,
 * which SFTP attributes do not carry, so this comparison is weaker, stage 3 design 4.3).
 *
 * @param size the bytes
 * @param modifiedMillis the modification time in milliseconds since the epoch, or -1 when the server did not report one
 * @param permissions the permission bits (the file-type bits are not part of the comparison)
 */
record LeafState(long size, long modifiedMillis, int permissions) {

    private static final int PERMISSION_BITS = 07777;

    /** The state the attributes show. */
    static LeafState of(SftpClient.Attributes attributes) {
        Objects.requireNonNull(attributes, "attributes");
        FileTime modified = attributes.getModifyTime();
        return new LeafState(attributes.getSize(), modified == null ? -1 : modified.toMillis(), attributes.getPermissions() & PERMISSION_BITS);
    }
}
