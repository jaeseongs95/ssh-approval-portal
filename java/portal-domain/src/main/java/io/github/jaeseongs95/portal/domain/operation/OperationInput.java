package io.github.jaeseongs95.portal.domain.operation;

import io.github.jaeseongs95.portal.domain.id.CanonicalForm;

/**
 * What an operation is asked to do, one variant per {@link OperationKind}. The input is part of the operation's contract: it never changes after the operation is
 * accepted, and a second request with the same key and a different input is a conflict, not the same operation (2.x operation-store.mjs:153-155, 170-174).
 */
public sealed interface OperationInput permits CommandInput, SourceInput, UploadInput, DownloadInput, AgentCliInput {

    /** The kind of operation this input belongs to. */
    OperationKind kind();

    /** Writes every field of the input, in a fixed order, into the canonical form that the contract digest is taken over. */
    CanonicalForm describeTo(CanonicalForm form);
}
