package io.github.jaeseongs95.portal.domain.command;

import java.util.Objects;

/**
 * A stored command policy with its revision. The revision counts the replacements; a decision made under one revision is void under another (a model answer that
 * arrives after the owner changed the policy does not approve, command-automation.mjs:27, 66-70).
 */
public record PolicySnapshot(long revision, CommandPolicyDocument document) {

    public PolicySnapshot {
        if (revision < 0) {
            throw new IllegalArgumentException("A policy revision is not negative");
        }
        Objects.requireNonNull(document, "document");
    }

    /**
     * Replaces the document, but only when the caller saw the current revision (command-state.mjs:45-51, "revision conflict"). Two owners who edit the same
     * revision cannot both win: the second gets {@link PolicyReplacement.RevisionConflict} and must read again.
     */
    public PolicyReplacement replaceWith(CommandPolicyDocument next, long expectedRevision) {
        Objects.requireNonNull(next, "next");
        if (expectedRevision != revision) {
            return new PolicyReplacement.RevisionConflict(expectedRevision, revision);
        }
        return new PolicyReplacement.Replaced(new PolicySnapshot(revision + 1, next));
    }

    /** True when a decision made under {@code decidedRevision} is still valid for this policy. */
    public boolean isRevision(long decidedRevision) {
        return revision == decidedRevision;
    }
}
