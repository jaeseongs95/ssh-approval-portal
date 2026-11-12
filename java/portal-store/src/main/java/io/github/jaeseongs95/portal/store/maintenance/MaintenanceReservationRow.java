package io.github.jaeseongs95.portal.store.maintenance;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

/**
 * Table {@code maintenance_reservation}: the one row (id 1) of the installation. {@code baseline} is the long-text column of the vendor script V6_1 and is
 * {@code null} until a baseline is stored; the nullable column is a nullable property of this persistence record, which no other layer sees.
 */
@Table("maintenance_reservation")
public record MaintenanceReservationRow(@Id int id, String ownerHash, String baseline) {
}
