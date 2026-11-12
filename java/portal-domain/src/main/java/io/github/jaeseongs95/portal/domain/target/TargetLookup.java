package io.github.jaeseongs95.portal.domain.target;

import io.github.jaeseongs95.portal.domain.id.TargetId;
import java.util.Objects;

/**
 * The answer to "which target is this id": found, not registered, or registered but switched off. 2.x gave one message for all three ("Select a registered enabled
 * target", target-router.mjs:53-57); a caller that has to tell them apart matches on the variant.
 */
public sealed interface TargetLookup permits TargetLookup.Found, TargetLookup.NotRegistered, TargetLookup.Disabled {

    /** The target is registered and takes requests. */
    record Found(ResolvedTarget target) implements TargetLookup {

        public Found {
            Objects.requireNonNull(target, "target");
        }
    }

    /** No target has this id. */
    record NotRegistered(TargetId id) implements TargetLookup {

        public NotRegistered {
            Objects.requireNonNull(id, "id");
        }
    }

    /** The target exists and is switched off. */
    record Disabled(TargetId id) implements TargetLookup {

        public Disabled {
            Objects.requireNonNull(id, "id");
        }
    }
}
