package io.github.jaeseongs95.portal.archchecks.fixtures.s3.ssh.platform;

import io.github.jaeseongs95.portal.archchecks.fixtures.s3.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.archchecks.fixtures.s3.app.remote.RemoteExecutor;
import org.springframework.resilience.annotation.Retryable;

/**
 * A RemoteExecutor implementation outside the ssh.exec package: A-NO-RETRY-EXEC follows the port, not only the package, so it is flagged here too
 * (RuleFixturesTest.a_noRetryExec).
 */
final class RetryingRemoteExecutor implements RemoteExecutor {
    @Override
    @Retryable
    public ExecutionReport run(String request) {
        return new ExecutionReport(request);
    }
}
