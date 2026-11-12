package io.github.jaeseongs95.portal.store.artifact;

/** The {@code purpose} column of {@code artifact}: a staged file with a public UUID, or a plain transfer made for one operation (2.x {@code purpose}). */
public enum ArtifactPurpose {
    STAGED, TRANSFER
}
