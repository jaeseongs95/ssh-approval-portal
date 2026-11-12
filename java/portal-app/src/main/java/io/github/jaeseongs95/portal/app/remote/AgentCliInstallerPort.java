package io.github.jaeseongs95.portal.app.remote;

/**
 * Installs an agent CLI on a target and reads its state (stage 3 design 6.2). The adapter keeps no record on the target: the operation journal is the only record, so a
 * receipt can never say "completed" for a switch that was not confirmed. Nothing is sent twice.
 */
public interface AgentCliInstallerPort {

    AgentCliInstallResult install(AgentCliInstallRequest request, ExecutionControl control);

    AgentCliStatusResult status(AgentCliStatusRequest request, ExecutionControl control);
}
