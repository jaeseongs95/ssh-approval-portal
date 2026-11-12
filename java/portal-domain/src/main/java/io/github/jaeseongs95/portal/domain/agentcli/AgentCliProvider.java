package io.github.jaeseongs95.portal.domain.agentcli;

/**
 * One agent command-line tool the portal can install: its id, the package that carries it and the command it provides. What differs between the tools lives in
 * an implementation of this interface, never in a branch of the shared code; a new tool is a new implementation that the application adds to the injected list
 * (stage 2 design 6.7, 2.x agent-cli.mjs:5-8).
 */
public interface AgentCliProvider {

    AgentCliProviderId id();

    /** The package name in the public registry, such as {@code @openai/codex}. */
    String packageName();

    /** The command the package puts on the target, such as {@code codex}. */
    String command();
}
