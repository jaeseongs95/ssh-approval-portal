package io.github.jaeseongs95.portal.domain.command;

/**
 * The facts about a request that only the server can state, and the only keys that may reach an evaluator as {@link ServerFacts}: a key outside this list cannot be
 * represented, so a caller can neither add a fact nor override one (execution-context.mjs:47-67, the whitelist of thirteen names).
 */
public enum ServerFactKey {
    TARGET_ID("targetId"),
    TARGET_DISPLAY_NAME("targetDisplayName"),
    TARGET_REVISION("targetRevision"),
    PROFILE("profile"),
    SSH_TARGET("sshTarget"),
    COMMAND_CLASS("commandClass"),
    POLICY_REVISION("policyRevision"),
    REQUEST_STATE("requestState"),
    EXTERNAL_DISCLOSURE("externalDisclosure"),
    MODEL_EXECUTION("modelExecution"),
    FALLBACK("fallback"),
    TARGET_PLATFORM("targetPlatform"),
    COMMAND_LANGUAGE("commandLanguage");

    private final String wire;

    ServerFactKey(String wire) {
        this.wire = wire;
    }

    /** The name of the fact in the context given to the evaluator. */
    public String wire() {
        return wire;
    }
}
