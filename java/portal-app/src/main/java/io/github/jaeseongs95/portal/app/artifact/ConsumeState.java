package io.github.jaeseongs95.portal.app.artifact;

import java.util.Objects;

/** Whether, and how, a staged file was used up (2.x {@code consumeReason}). */
public sealed interface ConsumeState permits ConsumeState.NotConsumed, ConsumeState.ConsumedBecause {

    record NotConsumed() implements ConsumeState {
    }

    record ConsumedBecause(ConsumeReason reason) implements ConsumeState {

        public ConsumedBecause {
            Objects.requireNonNull(reason, "reason");
        }
    }
}
