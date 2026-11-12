package io.github.jaeseongs95.portal.ssh.hostkey;

/**
 * What the host key policy reports to whoever runs the product. The policy decides and reports; it does not log. {@link LoggingHostKeyEvents} is the implementation of the
 * product (one log line per event); a test passes one that records the events.
 */
public interface HostKeyEvents {

    /** A host key was refused. */
    void refused(HostKeyRefusal refusal);

    /** The policy was built in {@code insecure} mode, which accepts every host key: said once, when the product starts. */
    void insecureModeActive();
}
