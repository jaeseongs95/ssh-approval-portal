package io.github.jaeseongs95.portal.app.journal;

import java.util.List;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.operation.Operation;

/** One page of the history and the cursor of the following page ({@link HistoryCursor.End} when this is the last). */
public record HistoryPage(List<Operation> operations, HistoryCursor next) {

    public HistoryPage {
        operations = List.copyOf(operations);
        Objects.requireNonNull(next, "next");
        if (next instanceof HistoryCursor.FirstPage) {
            throw new IllegalArgumentException("The next cursor of a page is After or End");
        }
    }
}
