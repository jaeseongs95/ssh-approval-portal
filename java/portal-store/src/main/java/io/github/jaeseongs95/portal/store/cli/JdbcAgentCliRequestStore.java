package io.github.jaeseongs95.portal.store.cli;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.jdbc.core.JdbcAggregateOperations;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import io.github.jaeseongs95.portal.app.cli.AgentCliBinding;
import io.github.jaeseongs95.portal.app.cli.AgentCliHistoryPage;
import io.github.jaeseongs95.portal.app.cli.AgentCliInstallRecord;
import io.github.jaeseongs95.portal.app.cli.AgentCliRequestStore;
import io.github.jaeseongs95.portal.app.cli.RemoteStatus;
import io.github.jaeseongs95.portal.app.journal.HistoryCursor;
import io.github.jaeseongs95.portal.app.journal.HistoryQuery;
import io.github.jaeseongs95.portal.domain.contract.HistoryErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.OperationId;

/**
 * {@link AgentCliRequestStore} over the table {@code agent_cli_request} of the migration V5 (2.x {@code agent-cli-state.mjs}). The row belongs to an AGENT_CLI row of
 * {@code operation}, which the journal inserts first (foreign key). The history page is keyset-paged by {@link AgentCliHistoryReader}; the {@code Operation} of each
 * entry comes from the journal's own read port {@link HistoryQuery#publicMetadata}, so this adapter does not map the operation tables a second time.
 */
@Repository
public class JdbcAgentCliRequestStore implements AgentCliRequestStore {

    private final AgentCliRequestRowRepository requests;
    private final JdbcAggregateOperations aggregates;
    private final AgentCliMapper mapper;
    private final AgentCliHistoryReader reader;
    private final HistoryQuery historyQuery;

    public JdbcAgentCliRequestStore(AgentCliRequestRowRepository requests, JdbcAggregateOperations aggregates, AgentCliMapper mapper, AgentCliHistoryReader reader,
                                    HistoryQuery historyQuery) {
        this.requests = requests;
        this.aggregates = aggregates;
        this.mapper = mapper;
        this.reader = reader;
        this.historyQuery = historyQuery;
    }

    @Override
    @Transactional
    public void insert(AgentCliInstallRecord record) {
        try {
            aggregates.insert(mapper.row(record));
        } catch (DuplicateKeyException e) {
            // The operation already has an install request. The contract has no code of its own for this yet (reported as a need).
            throw new RequestRefusedException(RequestErrorCode.REQUEST_REFUSED, e);
        }
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<AgentCliInstallRecord> findByOperation(OperationId operationId) {
        return requests.findById(operationId.value()).map(mapper::record);
    }

    @Override
    @Transactional
    public RemoteStatus recordRemote(OperationId operationId, RemoteStatus status) {
        AgentCliRequestRow row = requests.findById(operationId.value()).orElseThrow(() -> new RequestRefusedException(RequestErrorCode.OPERATION_NOT_FOUND));
        return mapper.remote(aggregates.update(mapper.withRemote(row, status)));
    }

    @Override
    @Transactional(readOnly = true)
    public AgentCliHistoryPage history(AgentCliBinding binding, HistoryCursor after) {
        AgentCliHistoryReader.Slice slice = reader.slice(binding, after);
        List<AgentCliHistoryPage.Entry> entries = new ArrayList<>();
        for (AgentCliHistoryReader.Hit hit : slice.hits()) {
            entries.add(new AgentCliHistoryPage.Entry(historyQuery.publicMetadata(hit.install().operationId())
                .orElseThrow(() -> new RequestRefusedException(HistoryErrorCode.HISTORY_METADATA_UNAVAILABLE)), hit.install()));
        }
        return new AgentCliHistoryPage(entries, slice.next());
    }
}
