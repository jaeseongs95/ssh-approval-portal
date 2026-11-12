package io.github.jaeseongs95.portal.app.capacity;

import java.util.List;
import java.util.Objects;
import java.util.regex.Pattern;

import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.CapacityOverride;

/**
 * The runtime capacity override (2.x {@code runtime-capacity.mjs:3, 12-26}): a revision token (32 hex), the installation values and the per-target overrides.
 * An override of a target that is no longer configured is kept (2.x {@code :21}), so the list is not checked against the targets here.
 */
public record CapacityState(String revision, Capacity queueCapacity, Capacity maxConcurrency, List<TargetCapacity> targets) {

    private static final Pattern REVISION = Pattern.compile("[a-f0-9]{32}");

    public CapacityState {
        Objects.requireNonNull(revision, "revision");
        Objects.requireNonNull(queueCapacity, "queueCapacity");
        Objects.requireNonNull(maxConcurrency, "maxConcurrency");
        targets = List.copyOf(targets);
        if (!REVISION.matcher(revision).matches()) {
            throw new IllegalArgumentException("A capacity revision is 32 lower-case hex characters");
        }
    }

    /** The override of one target; each value is inherited or explicit. */
    public record TargetCapacity(TargetId targetId, CapacityOverride queueCapacity, CapacityOverride maxConcurrency) {

        public TargetCapacity {
            Objects.requireNonNull(targetId, "targetId");
            Objects.requireNonNull(queueCapacity, "queueCapacity");
            Objects.requireNonNull(maxConcurrency, "maxConcurrency");
        }
    }
}
