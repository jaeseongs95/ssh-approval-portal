package io.github.jaeseongs95.portal.ssh.profile;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/** {@link ProfileEvents} that write one WARN log line per event. */
@Component
public final class LoggingProfileEvents implements ProfileEvents {

    private static final Logger LOG = LoggerFactory.getLogger(LoggingProfileEvents.class);

    @Override
    public void accessWarning(String reason) {
        LOG.warn("{}", reason);
    }

    @Override
    public void policyNotEnforced() {
        LOG.warn("[policy] is accepted for compatibility and is not enforced");
    }
}
