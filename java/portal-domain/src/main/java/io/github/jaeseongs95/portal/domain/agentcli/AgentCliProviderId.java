package io.github.jaeseongs95.portal.domain.agentcli;

import com.fasterxml.jackson.annotation.JsonValue;

/** The agent command-line tools the portal can install on a target. The wire names are the 2.x catalog ids {@code codex} and {@code claude}. */
public enum AgentCliProviderId {
    CODEX("codex"), CLAUDE("claude");

    private final String wire;

    AgentCliProviderId(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }

    /** The provider of a wire name; exactly {@code codex} or {@code claude} (2.x agent-cli.mjs:14-17 refused every other text, including property names). */
    public static AgentCliProviderId parse(String text) {
        for (AgentCliProviderId id : values()) {
            if (id.wire.equals(text)) {
                return id;
            }
        }
        throw new IllegalArgumentException("Unsupported CLI provider");
    }
}
