package io.github.jaeseongs95.portal.archchecks.fixtures.s3.app;

import org.apache.sshd.client.SshClient;

/** Breaks A-MINA on purpose: an app class that knows the SSH library (RuleFixturesTest.a_mina). */
final class AppUsesMina {
    Object client() {
        return SshClient.setUpDefaultClient();
    }
}
