package io.github.jaeseongs95.portal.app.history;

/** How the target of a listed operation stands now (2.x {@code history.targetStatus}): as it was when the operation ran, changed since, or switched off. */
public enum TargetStatus {
    /** The target is enabled and has the revision and the write profile the operation recorded. */
    ACTIVE,
    /** The target is enabled but its revision or its profile is not the one the operation recorded. */
    CHANGED,
    /** The target is registered and switched off. */
    DISABLED
}
