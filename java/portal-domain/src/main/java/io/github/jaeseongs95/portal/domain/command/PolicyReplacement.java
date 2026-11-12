package io.github.jaeseongs95.portal.domain.command;

import java.util.Objects;

/** What replacing a policy gives: the new snapshot, or the conflict between the revision the caller saw and the current one. */
public sealed interface PolicyReplacement permits PolicyReplacement.Replaced, PolicyReplacement.RevisionConflict {

    record Replaced(PolicySnapshot snapshot) implements PolicyReplacement {
        public Replaced {
            Objects.requireNonNull(snapshot, "snapshot");
        }
    }

    record RevisionConflict(long expected, long actual) implements PolicyReplacement {
    }
}
