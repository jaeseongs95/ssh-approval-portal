package io.github.jaeseongs95.portal.domain.operation;

import java.util.Objects;

/**
 * Names the resource an operation works on, so that two operations on the same resource of the same target revision never run together and an operation whose
 * result is unknown keeps the resource fenced until the owner reconciles it (2.x operation-scheduler.mjs:99, operation-store.mjs:257).
 */
public sealed interface ConflictKey permits ConflictKey.None, ConflictKey.Of {

    /** The operation does not fence any resource. */
    record None() implements ConflictKey {
    }

    /** The operation fences the named resource: 1 to 512 characters. */
    record Of(String value) implements ConflictKey {

        public Of {
            Objects.requireNonNull(value, "value");
            if (value.isEmpty() || value.length() > 512) {
                throw new IllegalArgumentException("A conflict key is 1 to 512 characters");
            }
        }
    }
}
