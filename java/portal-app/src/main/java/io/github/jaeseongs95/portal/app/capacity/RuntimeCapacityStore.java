package io.github.jaeseongs95.portal.app.capacity;

import java.util.Optional;

/** The runtime capacity override, one row for the installation (2.x {@code runtime-capacity-state.mjs}). */
public interface RuntimeCapacityStore {

    /** {@code Optional} here has the one meaning "nothing was stored yet". */
    Optional<CapacityState> read();

    /** Stores {@code initial} when nothing is stored; an existing value is kept and returned (two first writers: one wins, the other reads). */
    CapacityState initialize(CapacityState initial);

    /** Replaces the value when the stored revision is {@code expectedRevision}; another revision throws {@code RequestRefusedException(CAPACITY_REVISION_CONFLICT)}. */
    void compareAndSet(String expectedRevision, CapacityState next);
}
