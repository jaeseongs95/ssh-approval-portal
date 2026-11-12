package io.github.jaeseongs95.portal.domain.command;

/**
 * Whether the policy is still the one the evaluation started under. When it changed, no automatic decision stands: the request goes to the owner
 * (command-automation.mjs:27, 66-70, "No await between freshness check, decision record and execution claim").
 */
public enum PolicyFreshness {
    CURRENT,
    CHANGED
}
