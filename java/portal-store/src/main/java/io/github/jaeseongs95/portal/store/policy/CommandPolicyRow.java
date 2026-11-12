package io.github.jaeseongs95.portal.store.policy;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

/** Table {@code command_policy}: the one row (id 1) that carries the revision of the policy. The migration V4 seeds it with revision 0 (the empty policy). */
@Table("command_policy")
public record CommandPolicyRow(@Id int id, long revision) {
}
