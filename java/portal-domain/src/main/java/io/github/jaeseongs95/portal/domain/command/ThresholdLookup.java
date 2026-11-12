package io.github.jaeseongs95.portal.domain.command;

import java.util.Objects;

/** The answer to "which threshold does this rule have for an evaluator": one, or none. A missing threshold is a fact of the rule, not an absent value. */
public sealed interface ThresholdLookup permits ThresholdLookup.Configured, ThresholdLookup.NotConfigured {

    record Configured(Threshold threshold) implements ThresholdLookup {
        public Configured {
            Objects.requireNonNull(threshold, "threshold");
        }
    }

    record NotConfigured() implements ThresholdLookup {
    }
}
