package io.github.jaeseongs95.portal.ssh.profile;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;

/** What the product logs when the profile file has something worth saying and not worth stopping for: one WARN line for each event, read through a Logback list appender. */
class LoggingProfileEventsTest {

    private Logger logger;
    private ListAppender<ILoggingEvent> appender;

    @BeforeEach
    void listenToTheLogger() {
        logger = (Logger) LoggerFactory.getLogger(LoggingProfileEvents.class);
        appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
    }

    @AfterEach
    void stopListening() {
        logger.detachAppender(appender);
        appender.stop();
    }

    @Test
    @DisplayName("[policy] (decision of the lead): the product logs one WARN: [policy] is accepted for compatibility and is not enforced")
    void thePolicyWarningIsOneLine() {
        new LoggingProfileEvents().policyNotEnforced();

        assertThat(appender.list).singleElement().satisfies(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.WARN);
            assertThat(event.getFormattedMessage()).isEqualTo("[policy] is accepted for compatibility and is not enforced");
        });
    }

    @Test
    @DisplayName("VR-329: a profile file that others may read is one WARN line with the reason")
    void theAccessWarningIsOneLine() {
        new LoggingProfileEvents().accessWarning("Config path c.toml can be read by Users (access control list)");

        assertThat(appender.list).singleElement().satisfies(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.WARN);
            assertThat(event.getFormattedMessage()).contains("can be read by Users");
        });
    }
}
