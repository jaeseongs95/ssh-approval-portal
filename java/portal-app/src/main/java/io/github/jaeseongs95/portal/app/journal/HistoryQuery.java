package io.github.jaeseongs95.portal.app.journal;

import java.util.Optional;

import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.operation.Operation;

/**
 * The read-only history (2.x {@code history-query.mjs}): public metadata only, newest first, at most 10,000 rows are scanned. The page size (20) and the response
 * limit (256 KiB) belong to the use case of stage 3. The columns that hold a command text or a result text are not read for a page; they are read for one operation.
 */
public interface HistoryQuery {

    HistoryPage page(HistoryFilter filter, HistoryCursor after, int pageSize);

    /** {@code Optional} here has the one meaning "no such operation". */
    Optional<Operation> publicMetadata(OperationId id);
}
