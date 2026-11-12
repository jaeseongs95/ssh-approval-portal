package io.github.jaeseongs95.portal.app.history;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

import org.springframework.stereotype.Service;

import io.github.jaeseongs95.portal.app.journal.HistoryCursor;
import io.github.jaeseongs95.portal.app.journal.HistoryFilter;
import io.github.jaeseongs95.portal.app.journal.HistoryPage;
import io.github.jaeseongs95.portal.app.journal.HistoryQuery;
import io.github.jaeseongs95.portal.app.target.TargetSource;
import io.github.jaeseongs95.portal.domain.error.HistoryErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.operation.AgentCliInput;
import io.github.jaeseongs95.portal.domain.operation.CommandInput;
import io.github.jaeseongs95.portal.domain.operation.DownloadInput;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationKind;
import io.github.jaeseongs95.portal.domain.operation.RecordedResult;
import io.github.jaeseongs95.portal.domain.operation.Settlement;
import io.github.jaeseongs95.portal.domain.operation.SourceInput;
import io.github.jaeseongs95.portal.domain.operation.UploadInput;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;
import io.github.jaeseongs95.portal.domain.target.TargetLookup;

/**
 * The history of finished operations as the owner reads it (2.x {@code history.mjs}, cases RC-B-393 to RC-B-401). The storage reads keyset pages of the journal
 * ({@link HistoryQuery}); this use case adds what only it knows (the page size and the response limit that the query leaves to it) and what depends on the targets as they are
 * configured now:
 * <ul>
 * <li>an operation whose target is no longer registered is not listed (RC-B-396);</li>
 * <li>every listed operation says whether its target is still as it ran ({@code ACTIVE}), was changed or is switched off;</li>
 * <li>an agent CLI installation is listed only while its target is enabled with the revision and the write profile it was approved for (RC-B-397);</li>
 * <li>a page holds at most {@value #PAGE_SIZE} entries and about {@value #RESPONSE_BYTES} bytes of text; the first entry that alone is larger than the limit is
 * {@code HISTORY_ENTRY_TOO_LARGE}, and a page that fills up early continues exactly after its last entry (RC-B-394, RC-B-399).</li>
 * </ul>
 * The use case only reads. The size of an entry is the UTF-8 bytes of the texts it carries (the command, its contexts, the paths, the texts of the result) plus a fixed amount
 * for the rest; the answer envelope of stage 4 may measure more exactly, and that measure replaces this one when it exists.
 */
@Service
public class HistoryService {

    /** The page size of the history (2.x {@code HISTORY_PAGE_SIZE}). */
    public static final int PAGE_SIZE = 20;
    /** The response limit of a page (2.x {@code HISTORY_RESPONSE_BYTES}). */
    public static final int RESPONSE_BYTES = 256 * 1024;
    /** What an entry weighs besides its texts: ids, states, times and the target fields. */
    static final int ENTRY_OVERHEAD_BYTES = 1024;
    /** The query scans at most 10,000 rows (its own bound); the walk over its pages stops there too. */
    private static final int MAX_QUERY_PAGES = 10_000 / PAGE_SIZE;

    private final HistoryQuery query;
    private final TargetSource targets;

    public HistoryService(HistoryQuery query, TargetSource targets) {
        this.query = query;
        this.targets = targets;
    }

    /** The page of the history that follows {@code after} for the filter. */
    public HistoryResult page(HistoryFilter filter, HistoryCursor after) {
        Objects.requireNonNull(filter, "filter");
        Objects.requireNonNull(after, "after");
        List<HistoryEntry> listed = collect(filter, after);
        List<HistoryEntry> shown = new ArrayList<>();
        long bytes = 0;
        for (HistoryEntry entry : listed.subList(0, Math.min(PAGE_SIZE, listed.size()))) {
            long weight = weigh(entry.operation());
            if (shown.isEmpty() && weight > RESPONSE_BYTES) {
                throw new RequestRefusedException(HistoryErrorCode.HISTORY_ENTRY_TOO_LARGE);
            }
            if (!shown.isEmpty() && bytes + weight > RESPONSE_BYTES) {
                return new HistoryResult(shown, continuationAfter(shown.get(shown.size() - 1)));
            }
            shown.add(entry);
            bytes += weight;
        }
        boolean more = listed.size() > shown.size();
        return new HistoryResult(shown, more ? continuationAfter(shown.get(shown.size() - 1)) : new HistoryCursor.End());
    }

    /** One operation with its full public metadata; one that does not exist or is not listed (its target is not registered) is {@code OPERATION_NOT_FOUND}. */
    public HistoryEntry entry(OperationId id) {
        Objects.requireNonNull(id, "id");
        Operation operation = query.publicMetadata(id).orElseThrow(() -> new RequestRefusedException(RequestErrorCode.OPERATION_NOT_FOUND));
        HistoryEntry entry = statusOf(operation).map(status -> new HistoryEntry(operation, status))
            .orElseThrow(() -> new RequestRefusedException(RequestErrorCode.OPERATION_NOT_FOUND));
        if (weigh(operation) > RESPONSE_BYTES) {
            throw new RequestRefusedException(HistoryErrorCode.HISTORY_ENTRY_TOO_LARGE);
        }
        return entry;
    }

    /** Walks the pages of the query until one more than a page is listed or the history ends; the extra one tells whether a following page exists. */
    private List<HistoryEntry> collect(HistoryFilter filter, HistoryCursor after) {
        List<HistoryEntry> listed = new ArrayList<>();
        HistoryCursor cursor = after;
        for (int pages = 0; pages < MAX_QUERY_PAGES && listed.size() <= PAGE_SIZE; pages++) {
            HistoryPage page = query.page(filter, cursor, PAGE_SIZE);
            for (Operation operation : page.operations()) {
                statusOf(operation).ifPresent(status -> listed.add(new HistoryEntry(operation, status)));
            }
            if (page.next() instanceof HistoryCursor.End) {
                break;
            }
            cursor = page.next();
        }
        return listed;
    }

    private HistoryCursor continuationAfter(HistoryEntry last) {
        return new HistoryCursor.After(last.operation().createdAt(), last.operation().id());
    }

    /** {@code Optional} here has the one meaning "not listed": the target is not registered, or an installation is not bound to the target as it is now. */
    private Optional<TargetStatus> statusOf(Operation operation) {
        return switch (targets.lookup(operation.targetId())) {
            case TargetLookup.NotRegistered notRegistered -> Optional.empty();
            case TargetLookup.Disabled disabled -> operation.kind() == OperationKind.AGENT_CLI ? Optional.empty() : Optional.of(TargetStatus.DISABLED);
            case TargetLookup.Found found -> {
                TargetStatus status = isAsItRan(operation, found.target()) ? TargetStatus.ACTIVE : TargetStatus.CHANGED;
                yield operation.kind() == OperationKind.AGENT_CLI && status != TargetStatus.ACTIVE ? Optional.empty() : Optional.of(status);
            }
        };
    }

    private boolean isAsItRan(Operation operation, ResolvedTarget target) {
        return operation.targetRevision().equals(target.revision()) && operation.profile().equals(target.target().writeProfile());
    }

    /** The UTF-8 bytes of the texts an operation carries, plus the fixed amount of an entry. */
    long weigh(Operation operation) {
        long bytes = ENTRY_OVERHEAD_BYTES;
        bytes += switch (operation.input()) {
            case CommandInput command -> utf8(command.command().value()) + utf8(command.callerContext().value()) + utf8(command.displayContext().value());
            case SourceInput source -> utf8(source.launcher().value()) + utf8(source.argvJson().value()) + utf8(source.cwd().value()) + utf8(source.callerContext().value())
                + utf8(source.displayContext().value());
            case UploadInput upload -> utf8(upload.remotePath().value()) + utf8(upload.fileName().value());
            case DownloadInput download -> utf8(download.remotePath().value()) + utf8(download.callerContext().value()) + utf8(download.displayContext().value());
            case AgentCliInput agentCli -> 0L;
        };
        if (operation.settlement() instanceof Settlement.Settled settled && settled.result() instanceof RecordedResult.Executed executed) {
            for (String text : executed.outcome().texts()) {
                bytes += utf8(text);
            }
        }
        return bytes;
    }

    private long utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8).length;
    }
}
