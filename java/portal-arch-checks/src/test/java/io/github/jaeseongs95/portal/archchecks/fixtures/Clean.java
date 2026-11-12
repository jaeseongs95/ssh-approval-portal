package io.github.jaeseongs95.portal.archchecks.fixtures;

import java.time.Clock;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** A class that follows every rule: no rule may flag it (RuleFixturesTest). */
final class Clean {

    private static final Logger LOG = LoggerFactory.getLogger(Clean.class);

    Instant at(Clock clock) {
        return Instant.now(clock);
    }

    void report(Exception failure) {
        LOG.error("the work failed", failure);
    }
}
