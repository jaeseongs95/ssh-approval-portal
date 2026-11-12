package io.github.jaeseongs95.portal.store.policy;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

/**
 * Table {@code command_policy_name}: the allowed or denied command names of a rule. The key is (target_id, list_kind, position); {@code targetId} carries
 * {@code @Id} because Spring Data JDBC wants one, so this table is written with {@code JdbcAggregateOperations#insert} and deleted with a statement, never with
 * {@code save} or {@code findById}. {@code position} keeps the order of the list; {@code commandName} is the text of the policy name as entered.
 */
@Table("command_policy_name")
public record PolicyNameRow(@Id String targetId, PolicyListKind listKind, int position, String commandName) {
}
