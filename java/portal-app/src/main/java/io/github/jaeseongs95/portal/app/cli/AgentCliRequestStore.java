package io.github.jaeseongs95.portal.app.cli;

import java.util.Optional;

import io.github.jaeseongs95.portal.app.journal.HistoryCursor;
import io.github.jaeseongs95.portal.domain.id.OperationId;

/**
 * The agent CLI part of the operations of kind {@code AGENT_CLI} (2.x {@code agent-cli-state.mjs}). The operation row itself is {@code OperationJournal}'s; this
 * store adds and reads the part that only a CLI install has.
 */
public interface AgentCliRequestStore {

    /** Stores the install record of an operation that the journal has accepted; one record per operation. */
    void insert(AgentCliInstallRecord record);

    /** {@code Optional} here has the one meaning "no such record". */
    Optional<AgentCliInstallRecord> findByOperation(OperationId operationId);

    /** Records what the target reported; returns the stored status. */
    RemoteStatus recordRemote(OperationId operationId, RemoteStatus status);

    /** At most 20 entries (2.x fetched 21 and cut). A cursor that is not an {@code After} of an existing row throws {@code RequestRefusedException(HISTORY_INVALID_CURSOR)}. */
    AgentCliHistoryPage history(AgentCliBinding binding, HistoryCursor after);
}
