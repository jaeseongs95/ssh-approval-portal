package io.github.jaeseongs95.portal.app.artifact;

/** Whether the owner keeps the artifact until it is used ({@code PINNED}) or the service may release it when it expires ({@code RELEASABLE}); 2.x {@code pinned}. */
public enum ArtifactRetention {
    PINNED, RELEASABLE
}
