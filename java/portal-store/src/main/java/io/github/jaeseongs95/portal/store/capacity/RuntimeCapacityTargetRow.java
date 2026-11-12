package io.github.jaeseongs95.portal.store.capacity;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

/**
 * Table {@code runtime_capacity_target}: the override of one target. A {@code null} capacity means "inherited" (the nullable column of this persistence record).
 * The table has no foreign key to the configured targets, so the override of a target that left the configuration stays.
 */
@Table("runtime_capacity_target")
public record RuntimeCapacityTargetRow(@Id String targetId, Integer queueCapacity, Integer maxConcurrency) {
}
