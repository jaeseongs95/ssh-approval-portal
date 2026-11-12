package io.github.jaeseongs95.portal.app.execution;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.agentcli.AgentCliRun;
import io.github.jaeseongs95.portal.app.agentcli.AgentCliService;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.app.remote.ExecutionTimeline;
import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchRefusedException;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationKind;

/**
 * Runs the operations of kind {@code AGENT_CLI}: it hands the accepted operation, the key it was accepted under and the target to {@link AgentCliService}, which checks the
 * plan, the intent, the expiry and the target binding before it fetches or sends anything, installs, and answers the outcome the operation settles from. A refusal of the
 * use case before anything was sent (a target that cannot install an agent CLI) is a refusal before dispatch, never an unknown result.
 */
@Component
public class AgentCliOperationRunner implements OperationRunner {

    private final AgentCliService installs;
    private final RunTargets targets;

    public AgentCliOperationRunner(AgentCliService installs, RunTargets targets) {
        this.installs = installs;
        this.targets = targets;
    }

    @Override
    public OperationKind kind() {
        return OperationKind.AGENT_CLI;
    }

    @Override
    public ExecutionReport run(Operation operation, ExecutionControl control) {
        AgentCliRun run = new AgentCliRun(operation.id(), operation.requestKey(), targets.of(operation), operation.targetRevision(), operation.profile());
        try {
            return new ExecutionReport(installs.install(run, control), ExecutionTimeline.empty());
        } catch (RequestRefusedException e) {
            throw new DispatchRefusedException(DispatchFailure.refused(DispatchReason.UNKNOWN, DispatchStage.CLI_GUARD), e);
        }
    }
}
