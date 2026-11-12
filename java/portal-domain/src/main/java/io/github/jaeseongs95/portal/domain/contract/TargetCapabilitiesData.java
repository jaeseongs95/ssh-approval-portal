package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Objects;

/** What an agent may do on one target (public-contract.mjs:53-56, {@code capabilities}): the shell of a command and seven yes-or-no abilities. */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record TargetCapabilitiesData(CommandShellWire commandShell, boolean fileTransfer, boolean elevatedFileTransfer, boolean pythonSource, boolean agentCli,
                                     boolean commandNameApproval, boolean desktop) {

    public TargetCapabilitiesData {
        Objects.requireNonNull(commandShell, "commandShell");
    }
}
