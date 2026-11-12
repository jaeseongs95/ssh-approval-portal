package io.github.jaeseongs95.portal.app.remote;

import java.util.List;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProviderId;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;

/**
 * What it takes to install an agent CLI on one kind of target: the release and the fixed commands, in order, that unpack it, check it and switch to it
 * ({@code TargetPlatform#agentCliPlan}). The commands are portal constants (see {@link FixedRemoteCommand}); no part of a caller's input is in them.
 *
 * @param provider the tool
 * @param release the release the registry announced and the owner approved
 * @param commands the fixed commands the installer runs on the target, at least one
 */
public record AgentCliPlan(AgentCliProviderId provider, AgentRelease release, List<FixedRemoteCommand> commands) {

    public AgentCliPlan {
        Objects.requireNonNull(provider, "provider");
        Objects.requireNonNull(release, "release");
        commands = List.copyOf(commands);
        if (release.provider() != provider) {
            throw new IllegalArgumentException("The release is of another provider");
        }
        if (commands.isEmpty()) {
            throw new IllegalArgumentException("A plan has at least one command");
        }
    }
}
