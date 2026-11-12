package io.github.jaeseongs95.portal.app.artifact;

/** The life of an artifact (2.x {@code artifacts.mjs:101}); a final {@code CONSUMED} row keeps charging one byte of the budget (2.x {@code charge}). */
public enum ArtifactState {
    STAGING, READY, DELETING, CONSUMING, CONSUMED
}
