package io.github.jaeseongs95.portal.domain.agentcli;

/** The Anthropic Claude Code command-line tool (2.x agent-cli.mjs:7). */
public final class ClaudeCliProvider implements AgentCliProvider {

    @Override
    public AgentCliProviderId id() {
        return AgentCliProviderId.CLAUDE;
    }

    @Override
    public String packageName() {
        return "@anthropic-ai/claude-code";
    }

    @Override
    public String command() {
        return "claude";
    }
}
