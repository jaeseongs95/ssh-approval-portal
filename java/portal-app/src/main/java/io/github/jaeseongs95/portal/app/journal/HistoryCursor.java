package io.github.jaeseongs95.portal.app.journal;

import java.time.Instant;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.OperationId;

/** A position in the history, newest first (keyset paging on {@code (created_at, id)}, 2.x {@code agent-cli-state.mjs:33-43}). */
public sealed interface HistoryCursor permits HistoryCursor.FirstPage, HistoryCursor.After, HistoryCursor.End {

    /** Before the newest row; the argument of the first call. */
    record FirstPage() implements HistoryCursor {
    }

    /** After the given row; the argument of a following call and the {@code next} of a page that has more. */
    record After(Instant createdAt, OperationId id) implements HistoryCursor {

        public After {
            Objects.requireNonNull(createdAt, "createdAt");
            Objects.requireNonNull(id, "id");
        }
    }

    /** There is no following page; only the {@code next} of a page can be this. */
    record End() implements HistoryCursor {
    }
}
