package io.github.jaeseongs95.portal.store.maintenance;

import org.springframework.data.repository.CrudRepository;

/** Spring Data JDBC repository of the last-release row. */
interface MaintenanceReleaseRowRepository extends CrudRepository<MaintenanceReleaseRow, Integer> {
}
