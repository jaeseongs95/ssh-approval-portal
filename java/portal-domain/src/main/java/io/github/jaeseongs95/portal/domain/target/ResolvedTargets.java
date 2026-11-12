package io.github.jaeseongs95.portal.domain.target;

import io.github.jaeseongs95.portal.domain.id.TargetId;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/** The targets requests can be sent to, each with its profiles and revision, found by id. */
public record ResolvedTargets(List<ResolvedTarget> entries) {

    public ResolvedTargets {
        entries = List.copyOf(entries);
        Set<TargetId> seen = new HashSet<>();
        for (ResolvedTarget entry : entries) {
            if (!seen.add(entry.target().id())) {
                throw new IllegalArgumentException("Invalid or duplicate target configuration");
            }
        }
    }

    /** The target with the id: found, not registered, or registered and switched off. */
    public TargetLookup lookup(TargetId id) {
        Objects.requireNonNull(id, "id");
        for (ResolvedTarget entry : entries) {
            if (entry.target().id().equals(id)) {
                return entry.target().isEnabled() ? new TargetLookup.Found(entry) : new TargetLookup.Disabled(id);
            }
        }
        return new TargetLookup.NotRegistered(id);
    }
}
