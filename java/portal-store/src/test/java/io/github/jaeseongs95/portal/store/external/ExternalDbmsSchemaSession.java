package io.github.jaeseongs95.portal.store.external;

import org.junit.platform.launcher.LauncherSession;
import org.junit.platform.launcher.LauncherSessionListener;

/**
 * Makes the test schema of an external DBMS empty before the first test of the run and drops it after the last one, whether the tests passed or failed. It is a
 * {@code LauncherSessionListener}: the JUnit Platform opens one session around all the tests of a test JVM and closes it in a {@code finally}, and a listener that is
 * listed in {@code META-INF/services/org.junit.platform.launcher.LauncherSessionListener} is registered automatically
 * (https://docs.junit.org/current/user-guide/#launcher-api-launcher-session-listeners-custom; Gradle's JUnit Platform test worker opens a launcher session, checked in
 * Gradle 9.9.0). Nothing outside the schema is touched. On the default run on H2 there is no external DBMS and the listener does nothing.
 *
 * <p>A crash of the test JVM can leave the schema behind; the next run drops it first.
 */
public final class ExternalDbmsSchemaSession implements LauncherSessionListener {

    @Override
    public void launcherSessionOpened(LauncherSession session) {
        ExternalDbms.fromSystemProperties().ifPresent(ExternalDbms::recreateSchema);
    }

    @Override
    public void launcherSessionClosed(LauncherSession session) {
        ExternalDbms.fromSystemProperties().ifPresent(ExternalDbms::dropSchema);
    }
}
