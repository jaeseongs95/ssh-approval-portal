package io.github.jaeseongs95.portal.domain.command;

import java.util.Map;

/**
 * The thresholds of one rule by evaluator. A rule may have a threshold for any of the three evaluators or for none; a key other than the three does not exist
 * (command-policy.mjs:55 {@code keys(rule.thresholds, ['jev', 'luna', 'sonnet'])}).
 */
public record Thresholds(Map<EvaluatorProvider, Threshold> byProvider) {

    public Thresholds {
        byProvider = Map.copyOf(byProvider);
    }

    /** No evaluator has a threshold. */
    public static Thresholds none() {
        return new Thresholds(Map.of());
    }

    public ThresholdLookup lookup(EvaluatorProvider provider) {
        Threshold found = byProvider.get(provider);
        return found == null ? new ThresholdLookup.NotConfigured() : new ThresholdLookup.Configured(found);
    }
}
