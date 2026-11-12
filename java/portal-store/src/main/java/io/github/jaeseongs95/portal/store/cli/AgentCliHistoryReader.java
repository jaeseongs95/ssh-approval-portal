package io.github.jaeseongs95.portal.store.cli;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.springframework.jdbc.core.ResultSetExtractor;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcOperations;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.cli.AgentCliBinding;
import io.github.jaeseongs95.portal.app.cli.AgentCliInstallRecord;
import io.github.jaeseongs95.portal.app.journal.HistoryCursor;
import io.github.jaeseongs95.portal.domain.error.HistoryErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.OperationId;

/**
 * The keyset page of the install history of one binding (A-027, A-028, A-029). The order is newest first by (created_at, id) of the joined {@code operation} row, the
 * same key the cursor carries, so a request that arrives between two page reads or shares a timestamp with others is neither repeated nor skipped. The statement has no
 * LIMIT (not common to H2, PostgreSQL, MariaDB and MySQL): the extractor stops reading after one row more than a page, and that extra row only tells whether a next page
 * exists. The caller owns the transaction. The {@code Operation} of each entry is not read here (the journal reads it, see {@code JdbcAgentCliRequestStore#history}).
 */
@Component
class AgentCliHistoryReader {

    /** The page size of 2.x ({@code agent-cli-state.mjs}); the contract answers at most 20 entries. */
    static final int PAGE_SIZE = 20;

    private static final String SELECT_KEYS = """
        SELECT o.id AS operation_id, o.created_at AS created_at
        FROM agent_cli_request r JOIN operation o ON o.id = r.operation_id
        WHERE r.provider = :provider AND o.target_id = :targetId AND o.target_revision = :targetRevision AND o.profile = :profile""";
    private static final String KEYSET_PREDICATE = " AND (o.created_at < :createdAt OR (o.created_at = :createdAt AND o.id < :id))";
    private static final String NEWEST_FIRST = " ORDER BY o.created_at DESC, o.id DESC";
    private static final String CURSOR_ROW = """
        SELECT COUNT(*) FROM agent_cli_request r JOIN operation o ON o.id = r.operation_id
        WHERE o.id = :id AND o.created_at = :createdAt""";

    private final NamedParameterJdbcOperations jdbc;
    private final AgentCliRequestRowRepository requests;
    private final AgentCliMapper mapper;

    AgentCliHistoryReader(NamedParameterJdbcOperations jdbc, AgentCliRequestRowRepository requests, AgentCliMapper mapper) {
        this.jdbc = jdbc;
        this.requests = requests;
        this.mapper = mapper;
    }

    /** One entry of a page: the install record and the creation time of its operation. */
    record Hit(Instant createdAt, AgentCliInstallRecord install) {
    }

    /** A page of hits and the cursor of the page after it ({@link HistoryCursor.End} on the last page). */
    record Slice(List<Hit> hits, HistoryCursor next) {
    }

    /**
     * Reads the page after {@code after}.
     *
     * @throws RequestRefusedException {@link HistoryErrorCode#HISTORY_INVALID_CURSOR} when the cursor names no install request of that creation time
     */
    Slice slice(AgentCliBinding binding, HistoryCursor after) {
        return switch (after) {
            case HistoryCursor.End end -> new Slice(List.of(), new HistoryCursor.End());
            case HistoryCursor.FirstPage first -> page(binding, null);
            case HistoryCursor.After cursor -> {
                requireKnown(cursor);
                yield page(binding, cursor);
            }
        };
    }

    private Slice page(AgentCliBinding binding, HistoryCursor.After cursor) {
        MapSqlParameterSource parameters = new MapSqlParameterSource().addValue("provider", binding.provider().name())
            .addValue("targetId", binding.targetId().value()).addValue("targetRevision", binding.targetRevision().hex())
            .addValue("profile", binding.profile().value());
        String sql = SELECT_KEYS + NEWEST_FIRST;
        if (cursor != null) {
            parameters.addValue("createdAt", Timestamp.from(cursor.createdAt())).addValue("id", cursor.id().value());
            sql = SELECT_KEYS + KEYSET_PREDICATE + NEWEST_FIRST;
        }
        ResultSetExtractor<List<Key>> firstRows = rows -> {
            List<Key> keys = new ArrayList<>();
            while (keys.size() <= PAGE_SIZE && rows.next()) {
                keys.add(new Key(new OperationId(rows.getString("operation_id")), rows.getTimestamp("created_at").toInstant()));
            }
            return keys;
        };
        List<Key> keys = jdbc.query(sql, parameters, firstRows);
        boolean more = keys.size() > PAGE_SIZE;
        List<Key> pageKeys = more ? keys.subList(0, PAGE_SIZE) : keys;
        return new Slice(hits(pageKeys), more ? new HistoryCursor.After(pageKeys.get(pageKeys.size() - 1).createdAt(), pageKeys.get(pageKeys.size() - 1).id())
            : new HistoryCursor.End());
    }

    private List<Hit> hits(List<Key> keys) {
        Map<String, AgentCliRequestRow> byOperation = new HashMap<>();
        for (AgentCliRequestRow row : requests.findAllById(keys.stream().map(key -> key.id().value()).toList())) {
            byOperation.put(row.operationId(), row);
        }
        List<Hit> hits = new ArrayList<>();
        for (Key key : keys) {
            AgentCliRequestRow row = byOperation.get(key.id().value());
            if (row == null) {
                throw new IllegalStateException("The install request of operation " + key.id().value() + " vanished while its history page was read");
            }
            hits.add(new Hit(key.createdAt(), mapper.record(row)));
        }
        return hits;
    }

    private void requireKnown(HistoryCursor.After cursor) {
        MapSqlParameterSource parameters = new MapSqlParameterSource().addValue("id", cursor.id().value()).addValue("createdAt", Timestamp.from(cursor.createdAt()));
        Integer rows = jdbc.queryForObject(CURSOR_ROW, parameters, Integer.class);
        if (rows == null || rows < 1) {
            throw new RequestRefusedException(HistoryErrorCode.HISTORY_INVALID_CURSOR);
        }
    }

    private record Key(OperationId id, Instant createdAt) {
    }
}
