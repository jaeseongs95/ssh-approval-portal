package io.github.jaeseongs95.portal.domain.schedule;

/** Why nothing could be claimed although operations wait: each limit has its own reason, so a full slot, a busy target, an exhausted budget and a fenced resource are never one answer (defect D-0038). */
public enum SaturationReason {
    /** As many operations run as the global concurrency allows. */
    GLOBAL_CONCURRENCY,
    /** As many operations run on the target as its concurrency allows. */
    TARGET_CONCURRENCY,
    /** Running operations plus operations of unknown result fill the budget for unknown operations. */
    UNKNOWN_BUDGET,
    /** The resource every waiting operation of the target works on is fenced by a running or unknown operation. */
    CONFLICT_FENCE
}
