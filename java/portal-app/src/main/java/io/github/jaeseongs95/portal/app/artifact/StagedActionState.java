package io.github.jaeseongs95.portal.app.artifact;

/** The life of one action on a staged file (2.x {@code actions[].state}). */
public enum StagedActionState {
    RESERVED, SUBMITTED, REFUSED, SETTLED
}
