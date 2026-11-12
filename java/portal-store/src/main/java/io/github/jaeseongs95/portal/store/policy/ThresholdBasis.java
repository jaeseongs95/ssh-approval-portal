package io.github.jaeseongs95.portal.store.policy;

/** The basis of a stored threshold, the column {@code command_policy_threshold.basis} (stored by name): a probability threshold or the legacy confidence threshold. */
public enum ThresholdBasis {
    LEGACY, SAFETY_PROBABILITY_V1
}
