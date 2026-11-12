package io.github.jaeseongs95.portal.store.journal;

import java.time.Instant;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

import io.github.jaeseongs95.portal.domain.operation.ApprovalMode;
import io.github.jaeseongs95.portal.domain.operation.AuditState;
import io.github.jaeseongs95.portal.domain.operation.OperationKind;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.OutcomeCertainty;
import io.github.jaeseongs95.portal.domain.operation.Reconciliation;
import io.github.jaeseongs95.portal.domain.operation.RecoveryReason;

/**
 * Table {@code operation}: the contract and the state of one operation. A persistence record; the domain's {@code Operation} never sees it. Enum columns are the
 * domain enums stored by name (Spring Data JDBC default mapping), the nullable columns are nullable components. {@code readySequence}, {@code readyAt} and
 * {@code startedAt} are not part of the domain object: the store derives them from the transition it writes ({@link OperationMapper}).
 */
@Table("operation")
public record OperationRow(@Id String id, String requestKey, String ownerId, String targetId, String targetRevision, OperationKind kind, OperationState state, long version,
                           ApprovalMode approvalMode, String profile, String inputDigest, String contractDigest, String conflictKey, Long readySequence, Instant createdAt,
                           Instant updatedAt, Instant expiresAt, Instant readyAt, Instant startedAt, Instant finishedAt, Instant cancellationRequestedAt,
                           OutcomeCertainty outcomeCertainty, Reconciliation reconciliation, RecoveryReason recoveryReason, AuditState auditFailure) {
}
