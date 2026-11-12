package io.github.jaeseongs95.portal.domain.safety;

/**
 * The fixed vocabulary that explains why a response was not accepted (safety.mjs:61-64). The wire value is the constant name. An explanation only: the
 * acceptance of a response is decided by the checks of {@link SafetyAssessment.Assessed}, never by a diagnostic.
 */
public enum SafetyDiagnostic {
    ASSESSMENT_STATUS, MODEL_MISMATCH, LABEL_DOMAIN, CONFIDENCE_RANGE, PROBABILITY_KEYS, PROBABILITY_RANGE, PROBABILITY_SUM, CHOICE_NOT_MAX, USAGE_SCHEMA,
    ANSWER_KEYS, ANSWER_TYPE, CONTENT_TYPE, BODY_MISSING, BODY_READ, UTF8_DECODE, JSON_PARSE, UNCLASSIFIED_VALIDATION_FAILURE
}
