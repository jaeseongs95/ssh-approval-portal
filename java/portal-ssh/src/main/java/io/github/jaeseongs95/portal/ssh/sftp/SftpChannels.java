package io.github.jaeseongs95.portal.ssh.sftp;

import java.io.IOException;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.sftp.client.SftpClient;
import org.apache.sshd.sftp.client.SftpClientFactory;
import org.springframework.stereotype.Component;

/**
 * Opens the SFTP subsystem channel of a session. It is the one place that touches MINA's {@link SftpClientFactory}, so a test can replace it to put a fault in
 * front of an operation the embedded server cannot fail (a flush that is refused, a server extension that is not offered). The SFTP version is negotiated by MINA:
 * the highest both sides speak (OpenSSH's {@code sftp-server} speaks 3, which is why the adapter never uses an operation that needs a newer one).
 */
@Component
public class SftpChannels {

    /**
     * Opens the subsystem channel on the session; the caller closes the returned client.
     *
     * @param session an authenticated session
     * @return the SFTP client
     * @throws IOException when the server refuses the subsystem or the connection fails
     */
    public SftpClient open(ClientSession session) throws IOException {
        return SftpClientFactory.instance().createSftpClient(session);
    }
}
