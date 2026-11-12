package io.github.jaeseongs95.portal.store.policy;

import java.util.List;

import org.springframework.data.jdbc.repository.query.Modifying;
import org.springframework.data.jdbc.repository.query.Query;
import org.springframework.data.repository.CrudRepository;

/** Spring Data JDBC repository of the command names (composite key: only the statements below are used). */
interface PolicyNameRowRepository extends CrudRepository<PolicyNameRow, String> {

    /** Every name, ordered by the key so that the lists keep their positions. */
    @Query("SELECT * FROM command_policy_name ORDER BY target_id, list_kind, position")
    List<PolicyNameRow> findAllOrdered();

    /** Deletes every name. */
    @Modifying
    @Query("DELETE FROM command_policy_name")
    int deleteAllNames();
}
