package io.github.jaeseongs95.portal.ssh.sftp;

import java.io.IOException;
import java.util.List;
import java.util.Objects;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.sftp.client.SftpClient;
import org.apache.sshd.sftp.common.SftpException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Opens an SFTP channel with elevated rights on a POSIX target: the SFTP server of the target started with {@code sudo -n} on an {@code exec} channel and spoken to with
 * MINA's own client ({@link ExecSftpClient}; stage 3 design 6.1, decision Q8, shown to work on a real server by pilot P3-4). An elevated transfer is then the same adapter
 * code as a plain one over another channel: the same path checks, the same replacement, the same download, with the owner and group of a replaced file given back.
 *
 * <p>The server program is found over the plain SFTP channel: the first of the usual places ({@link #DEFAULT_SERVER_PATHS}, the platform's defaults for the distributions
 * of the OpenSSH packages) that holds a regular file. No second program is run for that, and {@code sudo -n} itself is the only external program: it is the target's way
 * to give the rights, and Java cannot replace it (docs/external-programs). A target where no server program is found, or where {@code sudo -n} does not start it (it
 * needs a password, the account is not allowed) has no elevated file work: the caller refuses the request, and nothing was written.
 */
@Component
public class SudoSftpChannels {

    /** Where the packages of OpenSSH put the SFTP server: Debian and Ubuntu, Red Hat and Fedora, Arch, and BSD-like systems. */
    public static final List<String> DEFAULT_SERVER_PATHS = List.of("/usr/lib/openssh/sftp-server", "/usr/libexec/openssh/sftp-server", "/usr/lib/ssh/sftp-server",
        "/usr/libexec/sftp-server");

    /** What opening the elevated channel came to. */
    public sealed interface Opening permits Opening.Opened, Opening.NoServer, Opening.NotStarted, Opening.Lost {
        /**
         * The server program runs under {@code sudo -n}; the caller closes the client.
         *
         * @param client the SFTP client
         */
        record Opened(SftpClient client) implements Opening {
            public Opened {
                Objects.requireNonNull(client, "client");
            }
        }

        /** The target has no SFTP server program in the usual places. */
        record NoServer() implements Opening {
        }

        /** The program was found and did not start under {@code sudo -n}: the account may not use it without a password. */
        record NotStarted() implements Opening {
        }

        /** The connection failed. */
        record Lost() implements Opening {
        }
    }

    private final SftpChannels plain;
    private final List<String> serverPaths;

    /**
     * @param plain opens the plain SFTP channel that looks for the server program
     */
    @Autowired
    public SudoSftpChannels(SftpChannels plain) {
        this(plain, DEFAULT_SERVER_PATHS);
    }

    /**
     * @param plain opens the plain SFTP channel that looks for the server program
     * @param serverPaths the places to look, in order
     */
    public SudoSftpChannels(SftpChannels plain, List<String> serverPaths) {
        this.plain = Objects.requireNonNull(plain, "plain");
        this.serverPaths = List.copyOf(serverPaths);
    }

    /**
     * Opens the elevated channel on the session.
     *
     * @param session an authenticated session
     * @return the open client, or why there is none
     */
    public Opening open(ClientSession session) {
        String server = null;
        try (SftpClient look = plain.open(session)) {
            for (String path : serverPaths) {
                try {
                    if (look.stat(path).isRegularFile()) {
                        server = path;
                        break;
                    }
                } catch (SftpException notThere) {
                    // not in this place; the next one
                }
            }
        } catch (IOException e) {
            return new Opening.Lost();
        }
        if (server == null) {
            return new Opening.NoServer();
        }
        try {
            return new Opening.Opened(ExecSftpClient.open(session, "sudo -n " + server));
        } catch (IOException e) {
            return session.isOpen() ? new Opening.NotStarted() : new Opening.Lost();
        }
    }
}
