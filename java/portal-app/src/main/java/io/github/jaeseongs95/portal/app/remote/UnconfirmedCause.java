package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

/**
 * Why the result of a write is not known. Every variant is an {@code UNKNOWN} outcome that the owner has to reconcile; none of them is ever turned into a
 * completed or a failed result by the adapter.
 */
public sealed interface UnconfirmedCause permits UnconfirmedCause.TransportLost, UnconfirmedCause.RestoreUnconfirmed, UnconfirmedCause.DurabilityUnconfirmed,
    UnconfirmedCause.CleanupUnconfirmed {

    /** The connection was lost after the first write: the target may or may not have the new file. */
    record TransportLost() implements UnconfirmedCause {
    }

    /**
     * A replacement failed and the original could not be confirmed restored.
     *
     * @param leftoverName the name of the backup file left on the target
     */
    record RestoreUnconfirmed(String leftoverName) implements UnconfirmedCause {

        public RestoreUnconfirmed {
            requireFileName(leftoverName);
        }
    }

    /** The replacement is in place and confirmed, and the step that makes it durable (a flush of the directory) failed (decision D3-15). */
    record DurabilityUnconfirmed() implements UnconfirmedCause {
    }

    /**
     * The temporary file could not be removed, so the target may hold what the owner did not ask for.
     *
     * @param leftoverName the name of the temporary file left on the target
     */
    record CleanupUnconfirmed(String leftoverName) implements UnconfirmedCause {

        public CleanupUnconfirmed {
            requireFileName(leftoverName);
        }
    }

    private static void requireFileName(String name) {
        Objects.requireNonNull(name, "leftoverName");
        if (name.isBlank() || name.length() > 255) {
            throw new IllegalArgumentException("A leftover file name is 1 to 255 characters");
        }
    }
}
