package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

/**
 * One command to run on a target.
 *
 * @param target where it runs and with which profile
 * @param command the command in the form the target's shell takes it
 * @param limits the deadline, the stop grace and the output cap
 * @param reply whether the server's answer to the {@code exec} request is awaited ({@code TargetPlatform#execReply})
 */
public record RemoteExecution(RemoteTarget target, PreparedCommand command, ExecutionLimits limits, ExecReply reply) {

    public RemoteExecution {
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(command, "command");
        Objects.requireNonNull(limits, "limits");
        Objects.requireNonNull(reply, "reply");
    }
}
