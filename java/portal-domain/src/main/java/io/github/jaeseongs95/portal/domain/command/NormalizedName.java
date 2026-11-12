package io.github.jaeseongs95.portal.domain.command;

import java.util.Objects;

/** What a grammar answers when asked to turn proposed text into a policy name: the name, or a refusal. A refusal is an answer, not an exception. */
public sealed interface NormalizedName permits NormalizedName.Accepted, NormalizedName.Rejected {

    record Accepted(PolicyName name) implements NormalizedName {
        public Accepted {
            Objects.requireNonNull(name, "name");
        }
    }

    record Rejected() implements NormalizedName {
    }
}
