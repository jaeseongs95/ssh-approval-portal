package io.github.jaeseongs95.portal.app.journal;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.TargetId;

/** Which targets a query looks at; a sealed pair instead of a nullable or {@code Optional} parameter. */
public sealed interface TargetFilter permits TargetFilter.AnyTarget, TargetFilter.OnlyTarget {

    /** Every target. */
    record AnyTarget() implements TargetFilter {
    }

    /** One target. */
    record OnlyTarget(TargetId targetId) implements TargetFilter {

        public OnlyTarget {
            Objects.requireNonNull(targetId, "targetId");
        }
    }
}
