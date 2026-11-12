package io.github.jaeseongs95.portal.app.remote;

/** An open forwarded channel. Closing it releases the channel; it does not throw. The members that carry bytes are added by stage 5. */
public interface ForwardHandle extends AutoCloseable {

    @Override
    void close();
}
