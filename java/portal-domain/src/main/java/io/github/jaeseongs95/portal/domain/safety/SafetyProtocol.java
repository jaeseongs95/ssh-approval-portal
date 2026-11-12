package io.github.jaeseongs95.portal.domain.safety;

/**
 * The fixed terms of the safety observation (safety.mjs:6-14). The observation has no authority to run anything: {@code automaticExecutionEnabled} is false and
 * the threshold stays {@code unvalidated} until a validation reference exists. A response is a candidate when it is {@code low_risk}, its {@code low_risk}
 * probability is at least {@link #candidateProbability()} and its confidence at least {@link #candidateConfidence()}.
 */
public record SafetyProtocol(String version, String adapterRevision, String model, double candidateProbability, double candidateConfidence, String thresholdStatus,
                             boolean automaticExecutionEnabled) {

    /** The protocol of 2.x, unchanged. */
    public static final SafetyProtocol CURRENT = new SafetyProtocol("ssh-command-risk-observation-v2", "typesafe-choice-v1", "jev-1.14.0", 0.999, 0.99, "unvalidated", false);
}
