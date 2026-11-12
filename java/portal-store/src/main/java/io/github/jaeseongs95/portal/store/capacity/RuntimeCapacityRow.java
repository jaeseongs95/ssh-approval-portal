package io.github.jaeseongs95.portal.store.capacity;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

/**
 * Table {@code runtime_capacity}: the one row (id 1) of the installation. {@code revision} is the 32-hex contract token the callers compare; {@code version} counts
 * the writes of the row (it rises by one with every update and is not a contract value). The CHECK constraints keep both capacities at 1 or more.
 */
@Table("runtime_capacity")
public record RuntimeCapacityRow(@Id int id, String revision, int queueCapacity, int maxConcurrency, long version) {
}
