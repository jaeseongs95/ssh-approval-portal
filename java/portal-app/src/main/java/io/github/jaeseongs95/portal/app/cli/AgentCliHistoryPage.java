package io.github.jaeseongs95.portal.app.cli;

import java.util.List;
import java.util.Objects;

import io.github.jaeseongs95.portal.app.journal.HistoryCursor;
import io.github.jaeseongs95.portal.domain.operation.Operation;

/** A page of the install history, newest first; {@code next} is {@link HistoryCursor.End} on the last page. */
public record AgentCliHistoryPage(List<Entry> entries, HistoryCursor next) {

    public AgentCliHistoryPage {
        entries = List.copyOf(entries);
        Objects.requireNonNull(next, "next");
    }

    /** An operation with its agent CLI part. */
    public record Entry(Operation operation, AgentCliInstallRecord install) {

        public Entry {
            Objects.requireNonNull(operation, "operation");
            Objects.requireNonNull(install, "install");
        }
    }
}
