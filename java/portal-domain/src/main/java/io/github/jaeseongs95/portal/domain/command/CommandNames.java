package io.github.jaeseongs95.portal.domain.command;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The names one side of a rule lists (approved or denied): at most 128, no two with the same comparison key (command-policy.mjs:43-71). The order the owner
 * wrote is kept.
 */
public record CommandNames(List<PolicyName> names) {

    /** The most names a rule lists on one side. */
    public static final int MAX_NAMES = 128;

    public CommandNames {
        names = List.copyOf(names);
        if (names.size() > MAX_NAMES) {
            throw new IllegalArgumentException("A rule lists at most " + MAX_NAMES + " command names");
        }
        Set<String> seen = new HashSet<>();
        for (PolicyName name : names) {
            if (!seen.add(name.key())) {
                throw new IllegalArgumentException("A rule lists a command name once: " + name.text());
            }
        }
    }

    /** No name at all. */
    public static CommandNames none() {
        return new CommandNames(List.of());
    }

    public boolean isEmpty() {
        return names.isEmpty();
    }

    /** True when a listed name has this comparison key. */
    public boolean containsKey(String key) {
        return names.stream().anyMatch(name -> name.key().equals(key));
    }

    /** True when every given key is listed. */
    public boolean containsAllKeys(List<String> keys) {
        return keys.stream().allMatch(this::containsKey);
    }

    /** The comparison keys, in the order the names were written. */
    public List<String> keys() {
        return names.stream().map(PolicyName::key).toList();
    }
}
