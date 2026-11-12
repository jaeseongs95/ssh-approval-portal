package io.github.jaeseongs95.portal.domain.safety;

import com.fasterxml.jackson.annotation.JsonValue;

/** The two answers of the binary safety question. The wire values are fixed by the question (safety.mjs:5): {@code low_risk} and {@code high_risk}. */
public enum SafetyLabel {
    LOW_RISK("low_risk"),
    HIGH_RISK("high_risk");

    private final String wire;

    SafetyLabel(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }

    /** The label for a wire value, or {@link LabelLookup.Unknown} for any other text (a provider's third label is not kept; the diagnostic is {@code LABEL_DOMAIN}). */
    public static LabelLookup lookup(String candidate) {
        for (SafetyLabel label : values()) {
            if (label.wire.equals(candidate)) {
                return new LabelLookup.Known(label);
            }
        }
        return new LabelLookup.Unknown();
    }

    /** The answer of {@link #lookup(String)}: a known label or a refusal. */
    public sealed interface LabelLookup permits LabelLookup.Known, LabelLookup.Unknown {

        record Known(SafetyLabel label) implements LabelLookup {
        }

        record Unknown() implements LabelLookup {
        }
    }
}
