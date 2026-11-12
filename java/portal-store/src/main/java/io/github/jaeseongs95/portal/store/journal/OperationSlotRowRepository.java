package io.github.jaeseongs95.portal.store.journal;

import java.util.List;

import org.springframework.data.jdbc.repository.query.Modifying;
import org.springframework.data.jdbc.repository.query.Query;
import org.springframework.data.repository.CrudRepository;
import org.springframework.data.repository.query.Param;

/** Spring Data JDBC repository of {@code operation_slot}. The key has two columns, so the rows are inserted, listed by scope and deleted by operation. */
interface OperationSlotRowRepository extends CrudRepository<OperationSlotRow, String> {

    List<OperationSlotRow> findByScopeOrderBySlotNoAsc(String scope);

    @Modifying
    @Query("DELETE FROM operation_slot WHERE operation_id = :operationId")
    int deleteByOperation(@Param("operationId") String operationId);
}
