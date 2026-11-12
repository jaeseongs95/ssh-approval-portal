package io.github.jaeseongs95.portal.app.artifact;

/** How a staged file left the staging area: the file was moved to the target or the staged copy was removed (2.x {@code consumeReason}). */
public enum ConsumeReason {
    MOVED, REMOVED
}
