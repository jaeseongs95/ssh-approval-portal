package io.github.jaeseongs95.portal.domain.command;

import com.fasterxml.jackson.annotation.JsonValue;

/** What a command name can do, in the words of the risk catalogue. */
public enum RiskCapability {
    INSPECTION("inspection"),
    READ_DATA("read_data"),
    CHANGE_STATE("change_state"),
    EXECUTE_CODE("execute_code"),
    DELEGATE_COMMANDS("delegate_commands");

    private final String wire;

    RiskCapability(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
