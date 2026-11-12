package io.github.jaeseongs95.portal.domain.target;

import io.github.jaeseongs95.portal.domain.id.TargetId;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * The administrator's targets: at least one, each id once (2.x targets.mjs:13-60). A default target, when one is named, has to be an enabled target of the list.
 */
public record Targets(List<Target> entries) {

    public Targets {
        entries = List.copyOf(entries);
        if (entries.isEmpty()) {
            throw new IllegalArgumentException("Configure at least one target");
        }
        Set<TargetId> seen = new HashSet<>();
        for (Target entry : entries) {
            if (!seen.add(entry.id())) {
                throw new IllegalArgumentException("Invalid or duplicate target configuration");
            }
        }
    }

    /** True when the id names an enabled target of the list. */
    public boolean hasEnabled(TargetId id) {
        Objects.requireNonNull(id, "id");
        return entries.stream().anyMatch(entry -> entry.id().equals(id) && entry.isEnabled());
    }

    /** The default target must be an enabled target of the list; the id is refused otherwise (2.x targets.mjs:56). */
    public TargetId requireEnabledDefault(TargetId id) {
        if (!hasEnabled(id)) {
            throw new IllegalArgumentException("Default target must name an enabled target");
        }
        return id;
    }
}
