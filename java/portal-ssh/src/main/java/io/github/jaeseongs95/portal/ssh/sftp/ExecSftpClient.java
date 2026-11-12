package io.github.jaeseongs95.portal.ssh.sftp;

import java.io.IOException;
import org.apache.sshd.client.channel.ChannelSubsystem;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.common.AttributeRepository;
import org.apache.sshd.common.SshConstants;
import org.apache.sshd.common.channel.StreamingChannel;
import org.apache.sshd.common.session.Session;
import org.apache.sshd.common.util.buffer.Buffer;
import org.apache.sshd.sftp.client.SftpErrorDataHandler;
import org.apache.sshd.sftp.client.SftpVersionSelector;
import org.apache.sshd.sftp.client.impl.DefaultSftpClient;

/**
 * An SFTP client of MINA that speaks to a program started by an {@code exec} request instead of to the {@code sftp} subsystem: the program is the SFTP server of the target
 * run under {@code sudo -n} (stage 3 design 6.1, pilot P3-4). MINA's public factory only opens the subsystem; the one extension point it offers is
 * {@link DefaultSftpClient#createSftpChannelSubsystem}, which this class overrides with a channel whose open request is {@code exec} with the command line. Everything else
 * (the version negotiation, every operation, the pipelined streams) is MINA's own code, so an elevated transfer runs the same adapter code as a plain one.
 *
 * <p>The constructor of {@code DefaultSftpClient} opens the channel before a subclass can set a field, so the command line travels as an attribute of the session
 * for the length of the call; the call holds the session's monitor, so two openings on one session do not see each other's command. The channel of the client belongs to
 * it: closing the client closes the channel and with it the program on the target.
 */
final class ExecSftpClient extends DefaultSftpClient {

    private static final AttributeRepository.AttributeKey<String> COMMAND = new AttributeRepository.AttributeKey<>();
    private static final String EXEC_REQUEST = "exec";

    private ExecSftpClient(ClientSession session) throws IOException {
        super(session, SftpVersionSelector.CURRENT, SftpErrorDataHandler.EMPTY);
    }

    /**
     * Starts the command on the session and speaks SFTP to it.
     *
     * @param session an authenticated session
     * @param commandLine the command line of the SFTP server (a fixed text of the portal)
     * @return the client; the caller closes it
     * @throws IOException when the program does not answer the SFTP handshake (it did not start, {@code sudo} refused) or the connection fails
     */
    static ExecSftpClient open(ClientSession session, String commandLine) throws IOException {
        synchronized (session) {
            session.setAttribute(COMMAND, commandLine);
            try {
                return new ExecSftpClient(session);
            } finally {
                session.removeAttribute(COMMAND);
            }
        }
    }

    @Override
    protected ChannelSubsystem createSftpChannelSubsystem(ClientSession session) {
        return new ExecChannel(session.getAttribute(COMMAND));
    }

    /** The channel of the client: MINA's own SFTP channel with another open request. */
    private final class ExecChannel extends SftpChannelSubsystem {

        private final String commandLine;

        ExecChannel(String commandLine) {
            this.commandLine = commandLine;
        }

        @Override
        protected void doOpen() throws IOException {
            Session session = getSession();
            boolean wantReply = false;
            Buffer buffer = session.createBuffer(SshConstants.SSH_MSG_CHANNEL_REQUEST, EXEC_REQUEST.length() + commandLine.length() + 32);
            buffer.putUInt(getRecipient());
            buffer.putString(EXEC_REQUEST);
            buffer.putBoolean(wantReply);
            buffer.putString(commandLine);
            addPendingRequest(EXEC_REQUEST, wantReply);
            writePacket(buffer);
            setStreaming(StreamingChannel.Streaming.Async);
            asyncIn = createAsyncInput(session);
            setOut(createStdOutputStream(session));
            setErr(createErrOutputStream(session));
        }
    }
}
