package io.github.jaeseongs95.portal.domain.desktop;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/**
 * What a desktop lease is bound to: the owner, the target, the revision of that target and the epoch of the lease (2.x desktop-lease.mjs:6-12). A request made
 * for another revision or an older epoch does not match. The lease itself, a state in memory, belongs to stage 5.
 */
public record DesktopBinding(String ownerId, TargetId targetId, TargetRevision targetRevision, long epoch) {

    public static final int MAX_OWNER_LENGTH = 256;

    /** The largest integer a JavaScript client reads exactly (2^53-1); 2.x accepted only safe integers as an epoch. */
    public static final long MAX_EPOCH = 9_007_199_254_740_991L;

    public DesktopBinding {
        Objects.requireNonNull(ownerId, "ownerId");
        Objects.requireNonNull(targetId, "targetId");
        Objects.requireNonNull(targetRevision, "targetRevision");
        if (ownerId.isEmpty() || ownerId.length() > MAX_OWNER_LENGTH) {
            throw new IllegalArgumentException("A desktop owner id has 1 to " + MAX_OWNER_LENGTH + " characters");
        }
        if (epoch < 1 || epoch > MAX_EPOCH) {
            throw new IllegalArgumentException("A desktop epoch is from 1 to 2^53-1");
        }
    }
}
