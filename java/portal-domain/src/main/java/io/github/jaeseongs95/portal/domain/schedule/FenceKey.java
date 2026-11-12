package io.github.jaeseongs95.portal.domain.schedule;

import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import java.util.Objects;

/** A fenced resource: a conflict key on a target at a revision. While an operation holds or has left it unknown, no other operation on it is started (2.x operation-store.mjs:257). */
public record FenceKey(TargetId targetId, TargetRevision targetRevision, String conflictKey) {

    public FenceKey {
        Objects.requireNonNull(targetId, "targetId");
        Objects.requireNonNull(targetRevision, "targetRevision");
        Objects.requireNonNull(conflictKey, "conflictKey");
    }
}
