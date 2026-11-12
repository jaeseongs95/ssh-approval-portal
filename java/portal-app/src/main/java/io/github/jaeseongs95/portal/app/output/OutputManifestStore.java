package io.github.jaeseongs95.portal.app.output;

import java.time.Instant;
import java.util.List;

/**
 * The metadata and the budget of the command outputs (2.x {@code manifest.sqlite}, table {@code outputs}). The payload bytes are {@link OutputPayloadStore}'s and are
 * written outside the transaction; every method here is one short transaction without file I/O (Principles 4.4).
 */
public interface OutputManifestStore {

    OutputLookup find(OutputId id, Instant now);

    /** Reserves {@code expectedBytes} of the budget and creates a {@code PENDING} row that expires one hour after {@code at}. */
    OutputReservation reserve(OutputBinding binding, long expectedBytes, Instant at);

    /** Records the stream state of a pending output (open, then complete). */
    OutputManifest recordStream(OutputId id, StreamInfo stream);

    /** {@code PENDING} to {@code READY}: the renderings are known; the charge becomes the real size. */
    OutputManifest markReady(OutputId id, OutputFormats formats, long sizeBytes);

    /** {@code PENDING} to {@code UNAVAILABLE}; the row is kept until {@code expiresAt}. */
    void markUnavailable(OutputId id, Instant expiresAt);

    OutputBudget budget();

    /** Outputs whose expiry is not after {@code now}. */
    List<OutputManifest> expired(Instant now);

    /** Every output in one state; the start-up check reads the pending and the unavailable ones. */
    List<OutputManifest> inState(OutputState state);

    void delete(OutputId id);
}
