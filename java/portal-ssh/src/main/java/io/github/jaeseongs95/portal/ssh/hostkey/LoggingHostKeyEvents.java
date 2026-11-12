package io.github.jaeseongs95.portal.ssh.hostkey;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/** {@link HostKeyEvents} that write one log line per event: a refused key at WARN with its code and fingerprints, and the {@code insecure} mode at WARN when the product starts. */
@Component
public final class LoggingHostKeyEvents implements HostKeyEvents {

    private static final Logger LOG = LoggerFactory.getLogger(LoggingHostKeyEvents.class);

    @Override
    public void refused(HostKeyRefusal refusal) {
        LOG.warn("{}", refusal.describe());
    }

    @Override
    public void insecureModeActive() {
        LOG.warn("The SSH host key mode is insecure: every host key is accepted, so a connection can be taken over by a machine that poses as the target. "
            + "Use tofu or strict, or pin the key of the profile with trustedHostKey.");
    }
}
