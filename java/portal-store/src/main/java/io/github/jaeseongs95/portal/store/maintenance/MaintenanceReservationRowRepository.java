package io.github.jaeseongs95.portal.store.maintenance;

import org.springframework.data.jdbc.repository.query.Modifying;
import org.springframework.data.jdbc.repository.query.Query;
import org.springframework.data.repository.CrudRepository;
import org.springframework.data.repository.query.Param;

/** Spring Data JDBC repository of the reservation row. The statement is ANSI; the one-time baseline write is a conditional UPDATE (2.x {@code maintenance-state.mjs:26-31}). */
interface MaintenanceReservationRowRepository extends CrudRepository<MaintenanceReservationRow, Integer> {

    /** Stores the baseline when the owner is the holder and no baseline was stored yet; returns the number of rows changed (1 or 0). */
    @Modifying
    @Query("UPDATE maintenance_reservation SET baseline = :baseline WHERE id = 1 AND owner_hash = :owner AND baseline IS NULL")
    int storeBaselineOnce(@Param("owner") String owner, @Param("baseline") String baseline);
}
