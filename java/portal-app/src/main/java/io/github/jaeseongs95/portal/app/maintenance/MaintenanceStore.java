package io.github.jaeseongs95.portal.app.maintenance;

import java.util.Optional;

/**
 * The maintenance reservation, one row for the installation (2.x {@code maintenance-state.mjs}). It is stored, so it survives a restart. At most one owner holds it,
 * and an owner that has held it once may not reserve again.
 */
public interface MaintenanceStore {

    MaintenanceStatus status(OwnerHash owner);

    /** True while some owner holds the reservation. */
    boolean occupied();

    /**
     * Takes the reservation. Another holder throws {@code RequestRefusedException(MAINTENANCE_ACTIVE)}; the owner of the last release throws
     * {@code RequestRefusedException(MAINTENANCE_OWNER_USED)}.
     */
    void reserve(OwnerHash owner);

    /** Stores the baseline once; a second call or another owner throws and changes nothing. */
    void saveBaseline(OwnerHash owner, PreservationBaseline baseline);

    /** {@code Optional} here has the one meaning "no baseline was stored for this owner". */
    Optional<PreservationBaseline> baseline(OwnerHash owner);

    /** Deletes the reservation and records the owner as the last release, in one transaction. */
    void release(OwnerHash owner);
}
