package io.github.jaeseongs95.portal.domain.target;

import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.id.CanonicalForm;
import java.util.Objects;

/**
 * A capacity a target sets for itself, or none: then the target inherits the installation's default (2.x targets.mjs, queueCapacity and maxConcurrency; an absent
 * or null value inherits). Stage 2 design 4.5.
 */
public sealed interface CapacityOverride permits CapacityOverride.Inherited, CapacityOverride.Explicit {

    /** The capacity in force for the target: its own when set, otherwise the default. */
    Capacity orElse(Capacity installationDefault);

    /** Writes the override into a canonical form: the number, or a marker for none. */
    CanonicalForm describeTo(CanonicalForm form, String name);

    /** The target has no capacity of its own. */
    record Inherited() implements CapacityOverride {

        @Override
        public Capacity orElse(Capacity installationDefault) {
            return installationDefault;
        }

        @Override
        public CanonicalForm describeTo(CanonicalForm form, String name) {
            return form.absent(name);
        }
    }

    /** The target sets its own capacity. */
    record Explicit(Capacity capacity) implements CapacityOverride {

        public Explicit {
            Objects.requireNonNull(capacity, "capacity");
        }

        @Override
        public Capacity orElse(Capacity installationDefault) {
            return capacity;
        }

        @Override
        public CanonicalForm describeTo(CanonicalForm form, String name) {
            return form.field(name, capacity.value());
        }
    }
}
