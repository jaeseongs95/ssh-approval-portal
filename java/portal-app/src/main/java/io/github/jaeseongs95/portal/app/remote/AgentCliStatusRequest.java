package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProviderId;

/**
 * A read-only question about the installation of a tool on a target. It sends no write and no input from a caller.
 *
 * @param target where to look
 * @param provider which tool
 * @param limits the deadline, the stop grace and the output cap of the read-only commands
 */
public record AgentCliStatusRequest(RemoteTarget target, AgentCliProviderId provider, ExecutionLimits limits) {

    public AgentCliStatusRequest {
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(provider, "provider");
        Objects.requireNonNull(limits, "limits");
    }
}
