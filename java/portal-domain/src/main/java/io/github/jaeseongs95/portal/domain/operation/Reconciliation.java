package io.github.jaeseongs95.portal.domain.operation;

/** Whether the owner has to compare the target with the record before the result can be trusted. It is {@link #REQUIRED} exactly while the operation is unknown. */
public enum Reconciliation {
    NOT_REQUIRED, REQUIRED
}
