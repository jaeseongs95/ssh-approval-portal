package io.github.jaeseongs95.portal.store.journal;

import org.springframework.data.repository.CrudRepository;

/** Spring Data JDBC repository of {@code operation_result}. */
interface OperationResultRowRepository extends CrudRepository<OperationResultRow, String> {
}
