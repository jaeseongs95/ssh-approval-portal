package io.github.jaeseongs95.portal.store.cli;

import org.springframework.data.repository.CrudRepository;

/** Spring Data JDBC repository of the install requests (single-column key: {@code findById}, {@code findAllById}; writes go through {@code JdbcAggregateOperations}). */
interface AgentCliRequestRowRepository extends CrudRepository<AgentCliRequestRow, String> {
}
