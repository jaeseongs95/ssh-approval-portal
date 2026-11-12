package io.github.jaeseongs95.portal.archchecks.fixtures.s3.store;

import org.apache.sshd.client.SshClient;

/** Breaks A-MINA on purpose: a store class that knows the SSH library (RuleFixturesTest.a_mina). */
final class StoreUsesMina {
    Object client() {
        return SshClient.setUpDefaultClient();
    }
}
