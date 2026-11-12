package io.github.jaeseongs95.portal.app.remote;

import java.io.InputStream;
import java.io.OutputStream;

/** The open binary streams of a remote command: what it writes (read from {@link #output()}) and what it reads (write to {@link #input()}). Closing releases the channel. */
public interface StreamHandle extends AutoCloseable {

    /** The standard output of the remote command. */
    InputStream output();

    /** The standard input of the remote command. */
    OutputStream input();

    @Override
    void close();
}
