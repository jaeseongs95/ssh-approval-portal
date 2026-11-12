package io.github.jaeseongs95.portal.domain.agentcli;

import com.fasterxml.jackson.annotation.JsonValue;

/** What an installation request asks for (2.x agent-cli.mjs:38). The helper's read-only actions (inspect, status, login check) are not requests and live in stage 3. */
public enum AgentCliAction {
    INSTALL("install"), UPDATE("update");

    private final String wire;

    AgentCliAction(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }

    /** The action of a wire name; exactly {@code install} or {@code update}. */
    public static AgentCliAction parse(String text) {
        for (AgentCliAction action : values()) {
            if (action.wire.equals(text)) {
                return action;
            }
        }
        throw new IllegalArgumentException("Invalid CLI action");
    }
}
