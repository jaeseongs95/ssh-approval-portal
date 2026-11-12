package io.github.jaeseongs95.portal.store.maintenance;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

/** Table {@code maintenance_release}: the one row (id 1) that remembers the owner of the last release, so that the owner cannot reserve again. */
@Table("maintenance_release")
public record MaintenanceReleaseRow(@Id int id, String ownerHash) {
}
