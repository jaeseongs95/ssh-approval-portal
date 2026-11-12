package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

/**
 * A command whose standard streams are kept open as binary streams (no terminal), for a helper the desktop module talks to. Only the shape is fixed in stage 3.
 *
 * @param target where it runs
 * @param command the command line, as the target's shell takes it
 * @param limits the deadline and the stop grace; the output cap is not used for a stream
 * @param reply whether the answer to the {@code exec} request is awaited
 */
public record StreamRequest(RemoteTarget target, PreparedCommand command, ExecutionLimits limits, ExecReply reply) {

    public StreamRequest {
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(command, "command");
        Objects.requireNonNull(limits, "limits");
        Objects.requireNonNull(reply, "reply");
    }
}
