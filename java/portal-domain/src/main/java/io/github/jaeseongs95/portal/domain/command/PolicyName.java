package io.github.jaeseongs95.portal.domain.command;

/**
 * The name of a program or cmdlet as a command policy lists it. A policy approves or denies <em>names</em>; arguments never take part (2.x command-policy.mjs,
 * "Name matching ignores arguments"). The text is what the owner typed and what the document keeps; the key is what two names are compared by: a Linux name is
 * compared as written, a Windows name by its normalised, case-folded form (windows-command-line.mjs:11-19).
 */
public sealed interface PolicyName permits LinuxPolicyName, WindowsPolicyName {

    /** The name as written in the policy. */
    String text();

    /** The form two names are compared by. */
    String key();
}
