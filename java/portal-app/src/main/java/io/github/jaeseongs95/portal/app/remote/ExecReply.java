package io.github.jaeseongs95.portal.app.remote;

/**
 * Whether the {@code exec} request of a command is answered by the server (stage 3 design 3.2, decision D3-06). With {@link #AWAITED} the executor asks for the
 * reply, and a refusal in the reply is the only proof that the command never started. With {@link #NOT_AWAITED} the executor sends the request and cannot tell a
 * refusal from a lost one, so a failure after the request is unknown. The target platform answers it ({@code TargetPlatform#execReply}), because a server of one
 * operating system may not answer where another does.
 */
public enum ExecReply {
    AWAITED, NOT_AWAITED
}
