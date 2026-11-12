package io.github.jaeseongs95.portal.ssh.exec;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.apache.sshd.client.channel.ChannelExec;

/**
 * An {@code exec} channel that tells the supervisor what MINA does not: when the request is written, and what the server answered to it.
 *
 * <ul>
 * <li>{@code doOpen} is where MINA writes the exec request, on the confirmation of the channel. The channel can be {@linkplain #abandonIfNotSent() abandoned} before that:
 * then the request is never written, even if the confirmation arrives later, so a stop that comes first is certain that nothing reached the target.</li>
 * <li>With the reply asked for ({@code CoreModuleProperties.REQUEST_EXEC_REPLY} on the channel), a FAILURE answer reaches {@link #handleFailure()} and the channel closes
 * (pilot P3-1: MINA closes it with no exit status and throws nothing), so the subclass is the one way to tell a refused exec from a channel that closed without a status.</li>
 * </ul>
 */
final class SupervisedExecChannel extends ChannelExec {

    /** What the supervisor is told; every call is made on a MINA thread and returns at once. */
    interface Events {
        /** The server confirmed the channel; the exec request is about to be written. */
        void channelConfirmed();

        /** The exec request was written to the transport. */
        void requestWritten();

        /** The server answered the exec request: success or failure. */
        void replyReceived(boolean accepted);

        /** Output data arrived (called for every packet, on MINA's thread, before it is handed to the stream): the first call is the first byte of output. */
        void outputArrived();
    }

    private final Object gate = new Object();
    private final Events events;
    private boolean abandoned;
    private boolean requestStarted;

    /**
     * @param tty true when the profile allocates a terminal: the channel then asks for a pseudo terminal of the type {@code xterm-256color}, 200 columns and 50 lines (2.x, VR-434)
     */
    SupervisedExecChannel(String commandLine, Events events, boolean tty) {
        super(commandLine, StandardCharsets.UTF_8, null, Map.of());
        this.events = events;
        if (tty) {
            setUsePty(true);
            setPtyType("xterm-256color");
            setPtyColumns(200);
            setPtyLines(50);
        }
    }

    /**
     * Makes sure the exec request is not written when the confirmation of the channel arrives.
     *
     * @return true when the request has not been written and now never will be; false when it was (or is being) written
     */
    boolean abandonIfNotSent() {
        synchronized (gate) {
            if (requestStarted) {
                return false;
            }
            abandoned = true;
            return true;
        }
    }

    @Override
    protected void doOpen() throws IOException {
        synchronized (gate) {
            if (abandoned) {
                throw new IOException("the exec request was not written: the run stopped before the channel was confirmed");
            }
            requestStarted = true;
        }
        events.channelConfirmed();
        super.doOpen();
        events.requestWritten();
    }

    @Override
    protected void doWriteData(byte[] data, int off, long len) throws IOException {
        events.outputArrived();
        super.doWriteData(data, off, len);
    }

    @Override
    protected void doWriteExtendedData(byte[] data, int off, long len) throws IOException {
        events.outputArrived();
        super.doWriteExtendedData(data, off, len);
    }

    @Override
    public void handleSuccess() throws IOException {
        events.replyReceived(true);
        super.handleSuccess();
    }

    @Override
    public void handleFailure() throws IOException {
        events.replyReceived(false);
        super.handleFailure();
    }
}
