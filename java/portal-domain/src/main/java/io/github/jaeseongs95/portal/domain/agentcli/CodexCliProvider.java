package io.github.jaeseongs95.portal.domain.agentcli;

/** The OpenAI Codex command-line tool (2.x agent-cli.mjs:6). */
public final class CodexCliProvider implements AgentCliProvider {

    @Override
    public AgentCliProviderId id() {
        return AgentCliProviderId.CODEX;
    }

    @Override
    public String packageName() {
        return "@openai/codex";
    }

    @Override
    public String command() {
        return "codex";
    }
}
