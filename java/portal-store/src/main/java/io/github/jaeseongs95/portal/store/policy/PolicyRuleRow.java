package io.github.jaeseongs95.portal.store.policy;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

import io.github.jaeseongs95.portal.domain.command.Fallback;
import io.github.jaeseongs95.portal.domain.command.SourceContract;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.target.Toggle;

/**
 * Table {@code command_policy_rule}: one rule per target (the primary key). The enum columns hold the names of the domain enums, which the CHECK constraints of
 * the migration V4 list; the long-form wire values of the 2.x JSON are not stored.
 */
@Table("command_policy_rule")
public record PolicyRuleRow(@Id String targetId, String targetRevision, String profile, TargetOs os, Toggle externalDisclosure, Toggle modelExecution,
                            Toggle automaticUploads, Toggle automaticDownloads, Toggle automaticSudo, Toggle testServer, SourceContract sourceContract,
                            Fallback fallback) {
}
