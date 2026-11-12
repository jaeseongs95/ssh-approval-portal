package io.github.jaeseongs95.portal.app.history;

import java.util.List;
import java.util.Objects;

import io.github.jaeseongs95.portal.app.journal.HistoryCursor;

/**
 * One page of the history: at most {@link HistoryService#PAGE_SIZE} entries, newest first, and where the next page starts ({@link HistoryCursor.End} when there is none).
 * A page that ends early because of the size limit still has a cursor that continues exactly after its last entry, so walking the pages visits every entry once.
 */
public record HistoryResult(List<HistoryEntry> entries, HistoryCursor next) {

    public HistoryResult {
        entries = List.copyOf(entries);
        Objects.requireNonNull(next, "next");
        if (next instanceof HistoryCursor.FirstPage) {
            throw new IllegalArgumentException("The next cursor of a page is After or End");
        }
    }
}
