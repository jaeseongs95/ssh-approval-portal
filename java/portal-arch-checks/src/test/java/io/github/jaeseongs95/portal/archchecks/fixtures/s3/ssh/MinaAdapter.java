package io.github.jaeseongs95.portal.archchecks.fixtures.s3.ssh;

import org.apache.sshd.client.SshClient;

/** The allowed home of the SSH library: a class of portal-ssh uses MINA. No rule may flag it (RuleFixturesTest). */
final class MinaAdapter {
    Object client() {
        return SshClient.setUpDefaultClient();
    }
}
