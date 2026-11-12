package io.github.jaeseongs95.portal.archchecks.fixtures.s3.ssh.exec;

import io.github.jaeseongs95.portal.archchecks.fixtures.s3.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.archchecks.fixtures.s3.app.remote.RemoteExecutor;
import org.springframework.core.retry.RetryTemplate;
import org.springframework.resilience.annotation.ConcurrencyLimit;
import org.springframework.resilience.annotation.Retryable;

// ssh.exec fixtures for A-NO-RETRY-EXEC (RuleFixturesTest.a_noRetryExec): three that let the framework send an exec again or queue it, one that does not.

/** @Retryable would send the request again after a failure the caller cannot see: A-NO-RETRY-EXEC. */
final class RetriesExec implements RemoteExecutor {
    @Override
    @Retryable
    public ExecutionReport run(String request) {
        return new ExecutionReport(request);
    }
}

/** Holds a RetryTemplate: A-NO-RETRY-EXEC. */
final class RetryTemplateExec {
    private final RetryTemplate template;

    RetryTemplateExec(RetryTemplate template) {
        this.template = template;
    }

    RetryTemplate template() {
        return template;
    }
}

/** @ConcurrencyLimit is also a framework-side wrapper around the call: A-NO-RETRY-EXEC. */
final class LimitsExec {
    @ConcurrencyLimit(1)
    String run(String request) {
        return request;
    }
}

/** The allowed shape: the request is sent once and the outcome is reported. No rule may flag it. */
final class PlainExec implements RemoteExecutor {
    @Override
    public ExecutionReport run(String request) {
        return new ExecutionReport(request);
    }
}
