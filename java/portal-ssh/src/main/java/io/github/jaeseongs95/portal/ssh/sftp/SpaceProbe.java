package io.github.jaeseongs95.portal.ssh.sftp;

import java.io.IOException;
import java.util.Objects;
import org.apache.sshd.sftp.client.SftpClient;
import org.apache.sshd.sftp.client.extensions.openssh.OpenSSHStatExtensionInfo;
import org.apache.sshd.sftp.client.extensions.openssh.OpenSSHStatPathExtension;
import org.apache.sshd.sftp.common.extensions.openssh.StatVfsExtensionParser;
import org.springframework.stereotype.Component;

/**
 * Tells whether the file system of a directory has no space left, with {@code statvfs@openssh.com}. OpenSSH's {@code sftp-server} speaks SFTP version 3, which has no
 * status for a full disk: it answers the plain {@code FAILURE} (status 4) that every other refusal without a name gets. A write that fails that way is a full disk or
 * something else, and only a question to the file system tells which; the answer decides whether the result says {@code NoSpace} or only the status (defect D-0034: a
 * full disk must not read as a permission problem or a lost connection). A server without the extension, or one that does not answer, gives no proof, and the result
 * keeps the plain status.
 */
@Component
public class SpaceProbe {

    /**
     * Whether the file system of the directory has no block left for an unprivileged user.
     *
     * @param client the SFTP client of the session
     * @param directory the SFTP path of the directory the file was being written to
     * @return true only when the server offers the extension, answers, and reports no available block
     */
    public boolean exhausted(SftpClient client, String directory) {
        Objects.requireNonNull(client, "client");
        Objects.requireNonNull(directory, "directory");
        if (!client.getServerExtensions().containsKey(StatVfsExtensionParser.NAME)) {
            return false;
        }
        try {
            OpenSSHStatExtensionInfo information = client.getExtension(OpenSSHStatPathExtension.class).stat(directory);
            return information.f_bavail == 0;
        } catch (IOException e) {
            return false;
        }
    }
}
