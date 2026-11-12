package io.github.jaeseongs95.portal.domain.target;

import java.util.Objects;

/**
 * What a target supports (2.x target-platform.mjs:8-14): the shell its commands run in, and whether file transfer, elevated file transfer, source requests, the
 * agent command line installer and approval by command name are available. A request for something the target does not support is refused with
 * {@code TARGET_CAPABILITY_UNSUPPORTED} by the caller that sees the capabilities; asking is never an exception.
 *
 * @param commandShell the shell commands run in
 * @param fileTransfer whether files can be transferred
 * @param elevatedFileTransfer whether files can be transferred with elevated rights
 * @param pythonSource whether source requests can run (a Windows target needs a configured Python)
 * @param agentCli whether the agent command line tool installer works
 * @param commandNameApproval whether commands can be approved by name
 */
public record TargetCapabilities(CommandShell commandShell, boolean fileTransfer, boolean elevatedFileTransfer, boolean pythonSource, boolean agentCli,
                                 boolean commandNameApproval) {

    public TargetCapabilities {
        Objects.requireNonNull(commandShell, "commandShell");
    }
}
