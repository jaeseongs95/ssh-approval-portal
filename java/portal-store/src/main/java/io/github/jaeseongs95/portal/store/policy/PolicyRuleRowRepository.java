package io.github.jaeseongs95.portal.store.policy;

import java.util.List;

import org.springframework.data.jdbc.repository.query.Modifying;
import org.springframework.data.jdbc.repository.query.Query;
import org.springframework.data.repository.CrudRepository;

/** Spring Data JDBC repository of the rules. Reads and deletes are ANSI statements; the rows are inserted with {@code JdbcAggregateOperations#insert}. */
interface PolicyRuleRowRepository extends CrudRepository<PolicyRuleRow, String> {

    /** Every rule, ordered by target id so that a read gives the same order every time. */
    @Query("SELECT * FROM command_policy_rule ORDER BY target_id")
    List<PolicyRuleRow> findAllOrdered();

    /** Deletes every rule; the names and thresholds are deleted first because they reference the rules. */
    @Modifying
    @Query("DELETE FROM command_policy_rule")
    int deleteAllRules();
}
