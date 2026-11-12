package io.github.jaeseongs95.portal.ssh.profile;

import java.util.List;
import java.util.Map;
import java.util.Set;

import io.github.jaeseongs95.portal.domain.classify.CommandClass;

/**
 * The {@code [policy]} table (vendor config/schema.js:196-217). 2.x did not use it, and 3.0 has no policy engine behind it, so the table is read and checked as the vendor
 * schema did and then left unused (decision proposed to the lead: accept and ignore, so that a file written for the vendor program still loads). {@code roleBindings} maps
 * a role to its tiers and a tier to the command classes it allows; a role or tier name that is empty or that is {@code __proto__}, {@code constructor} or
 * {@code prototype} is refused (PF-12), and a class that is not {@code read-only}, {@code safe}, {@code destructive} or {@code privileged} is refused by the reader.
 */
record TomlPolicy(Map<String, Map<String, List<CommandClass>>> roleBindings, List<String> denylist) {

    private static final Set<String> RESERVED = Set.of("__proto__", "constructor", "prototype");

    TomlPolicy {
        if (roleBindings != null) {
            roleBindings.forEach((role, tiers) -> {
                requireUsable(role);
                if (tiers != null) {
                    tiers.keySet().forEach(TomlPolicy::requireUsable);
                }
            });
        }
    }

    private static void requireUsable(String name) {
        if (name.isEmpty()) {
            throw new IllegalArgumentException("Role and tier names cannot be empty.");
        }
        if (RESERVED.contains(name)) {
            throw new IllegalArgumentException("Reserved name (__proto__, constructor, prototype). Rename the role or tier.");
        }
    }
}
