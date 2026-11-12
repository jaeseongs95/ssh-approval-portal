package io.github.jaeseongs95.portal.app.journal;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.operation.Operation;

/**
 * The answer of {@link OperationJournal#accept}: the row was written now, or the same request key with the same contract was accepted earlier and that operation
 * is returned (idempotent submit, 2.x {@code operation-store.mjs:170-174}). The same key with another contract is not a variant but an exception
 * ({@code OPERATION_KEY_CONFLICT}). Design 13.3 gives this type the name that the domain's {@code AdmissionDecision} must not have.
 */
public sealed interface JournalInsert permits JournalInsert.Inserted, JournalInsert.Existing {

    Operation operation();

    /** A new row was inserted by this call. */
    record Inserted(Operation operation) implements JournalInsert {

        public Inserted {
            Objects.requireNonNull(operation, "operation");
        }
    }

    /** The key was known; this is the stored operation. */
    record Existing(Operation operation) implements JournalInsert {

        public Existing {
            Objects.requireNonNull(operation, "operation");
        }
    }
}
