package io.github.jaeseongs95.portal.app.artifact;

import java.util.Objects;

/**
 * Whether, and how, a staged file was used up (2.x {@code consumeReason}). The reason is recorded when the use starts ({@link ArtifactRegistry#beginConsume}), so a
 * crash before the end leaves a state that says what the use was for and the recovery continues with the same reason.
 */
public sealed interface ConsumeState permits ConsumeState.NotConsumed, ConsumeState.Consuming, ConsumeState.ConsumedBecause {

    record NotConsumed() implements ConsumeState {
    }

    /** The use started for the reason and has not ended: the bytes may or may not be gone yet. */
    record Consuming(ConsumeReason reason) implements ConsumeState {

        public Consuming {
            Objects.requireNonNull(reason, "reason");
        }
    }

    record ConsumedBecause(ConsumeReason reason) implements ConsumeState {

        public ConsumedBecause {
            Objects.requireNonNull(reason, "reason");
        }
    }
}
