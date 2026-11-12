package io.github.jaeseongs95.portal.domain.operation;

/** How sure the portal is about what happened on the target: it never ran, it ran and exited, or it is not known (2.x operation-store.mjs:268). */
public enum OutcomeCertainty {
    NOT_DISPATCHED, EXITED, UNKNOWN
}
