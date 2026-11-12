package io.github.jaeseongs95.portal.archchecks.fixtures.s3.app.remote;

/** Stands for portal-app's RemoteExecutor port: A-NO-RETRY-EXEC covers every implementation, wherever it lives. */
public interface RemoteExecutor {
    ExecutionReport run(String request);
}
