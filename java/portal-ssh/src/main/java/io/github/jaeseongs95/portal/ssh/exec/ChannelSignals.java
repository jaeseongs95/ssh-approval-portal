package io.github.jaeseongs95.portal.ssh.exec;

import io.github.jaeseongs95.portal.domain.operation.SignalDelivery;
import java.io.IOException;
import org.apache.sshd.client.channel.ClientChannel;
import org.apache.sshd.common.SshConstants;
import org.apache.sshd.common.session.Session;
import org.apache.sshd.common.util.buffer.Buffer;
import org.springframework.stereotype.Component;

/**
 * Sends the {@code signal} channel request (RFC 4254 6.9). MINA 2.20.1 has no client method for it (stage 3 design 0.3, item 1), so the request is written as a packet with
 * the public {@code Session.createBuffer} and {@code Session.writePacket}, want-reply false (decision D3-05, pilot P3-3). This is the only class of the adapter that
 * knows the packet layout. A signal request is a request, never proof that the process ended: whether the server acts on it is the business of the executor's evidence.
 */
@Component
public final class ChannelSignals {

    static final String INTERRUPT = "INT";
    static final String TERMINATE = "TERM";
    static final String KILL = "KILL";

    /**
     * Writes the request to the transport.
     *
     * @param channel an open channel
     * @param name the signal name without the {@code SIG} prefix
     * @return {@link SignalDelivery#REQUESTED} when the packet was handed to the transport, {@link SignalDelivery#UNSUPPORTED} when it could not be written
     */
    SignalDelivery send(ClientChannel channel, String name) {
        try {
            Session session = channel.getSession();
            Buffer buffer = session.createBuffer(SshConstants.SSH_MSG_CHANNEL_REQUEST);
            buffer.putUInt(channel.getRecipient());
            buffer.putString("signal");
            buffer.putBoolean(false);
            buffer.putString(name);
            session.writePacket(buffer);
            return SignalDelivery.REQUESTED;
        } catch (IOException | RuntimeException e) {
            return SignalDelivery.UNSUPPORTED;
        }
    }
}
