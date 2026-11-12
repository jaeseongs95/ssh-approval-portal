package io.github.jaeseongs95.portal.app.remote;

/**
 * Runs one command on a target and owns its whole life: the time limit, the cancel and the output cap. It sends the request <em>at most once</em>: there is no retry
 * path, so a command whose request may have reached the target is never sent again, whatever failed afterwards.
 *
 * <p>The answer is an {@link ExecutionReport}, never an exception, for everything that happens once the work is under way (a lost connection, a deadline, a cancel,
 * a sink that failed). The two things that are thrown are a dispatch refusal from the {@link DispatchGuard} ({@code DispatchRefusedException}, before anything is
 * sent) and a programming error.
 */
public interface RemoteExecutor {

    ExecutionReport run(RemoteExecution request, OutputSink sink, ExecutionControl control);
}
