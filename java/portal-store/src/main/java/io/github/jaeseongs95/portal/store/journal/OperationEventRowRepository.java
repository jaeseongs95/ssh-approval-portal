package io.github.jaeseongs95.portal.store.journal;

import java.util.List;

import org.springframework.data.repository.CrudRepository;

/** Spring Data JDBC repository of {@code operation_event}. The key has two columns, so the rows are inserted and read by operation, never found by id. */
interface OperationEventRowRepository extends CrudRepository<OperationEventRow, String> {

    List<OperationEventRow> findByOperationIdOrderByVersionAsc(String operationId);
}
