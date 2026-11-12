package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.app.remote.CancelToken;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.ssh.testkit.EmbeddedSshServer;
import io.github.jaeseongs95.portal.ssh.testkit.SshTestClient;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.sshd.client.session.ClientSession;

/**
 * The session source of the file tests: a plain class that opens a new session of the test client for every lease (the product's pool is another module's work and
 * has its own tests). It counts the leases and the discards, so a test can say that a lost connection made the adapter discard its session and that nothing leased
 * a second session to send a request again.
 */
final class TestSessions implements SessionSource, AutoCloseable {

    static final String USER = "tester";
    static final String PASSWORD = "secret-for-the-test";

    private final SshTestClient client = SshTestClient.startAcceptingAnyHostKey();
    private final EmbeddedSshServer server;
    private final AtomicInteger leases = new AtomicInteger();
    private final AtomicInteger discards = new AtomicInteger();

    TestSessions(EmbeddedSshServer server) {
        this.server = server;
    }

    int leases() {
        return leases.get();
    }

    int discards() {
        return discards.get();
    }

    @Override
    public SessionAcquisition lease(RemoteTarget target, CancelToken cancel) {
        ClientSession session;
        try {
            session = client.open(server, USER, PASSWORD);
        } catch (IOException e) {
            return new SessionAcquisition.Unavailable(TransferFailureCause.CONNECT_FAILED);
        }
        leases.incrementAndGet();
        return new SessionAcquisition.Acquired(new SessionLease() {
            @Override
            public ClientSession session() {
                return session;
            }

            @Override
            public void discard() {
                discards.incrementAndGet();
            }

            @Override
            public void close() {
                session.close(true);
            }
        });
    }

    @Override
    public void close() {
        client.close();
    }
}
