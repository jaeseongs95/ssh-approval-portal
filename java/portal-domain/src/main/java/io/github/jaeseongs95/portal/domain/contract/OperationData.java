package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import java.util.Objects;

/**
 * The {@code data} of {@code submit}, {@code observe}, {@code cancel} and {@code artifact-finish}, and the {@code request} of {@code files} and
 * {@code artifact-status}: one operation as an agent sees it (public-contract.mjs:41-46, {@code operationData}). Times are epoch milliseconds.
 *
 * <p>A null component is the wire null (null = wire null) for {@code operationKey}, {@code targetId}, {@code targetRevision}, {@code approvalMode},
 * {@code expiresAt}, {@code finishedAt}, {@code failed}, {@code failureCode}, {@code remoteOutcome}, {@code allowedRoot}, {@code diagnostic},
 * {@code remoteCleanup}, {@code execution}, {@code output}, {@code artifact} and {@code outputPage}. {@code streamPage} is always null on the wire, so it has the
 * type {@link Void}. {@code state} is the domain's {@link OperationState}, whose wire values the baseline pins.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record OperationData(String id, String operationKey, OperationKindWire kind, OperationState state, String targetId, String targetRevision,
                            ApprovalModeWire approvalMode, long createdAt, Long expiresAt, Long finishedAt, Boolean failed, boolean auditFailure, String failureCode,
                            RemoteOutcomeWire remoteOutcome, String allowedRoot, Diagnostic diagnostic, RemoteCleanupWire remoteCleanup, ExecutionData execution,
                            OutputReference output, ArtifactSummary artifact, OutputPage outputPage, Void streamPage, boolean waitTimedOut) {

    public OperationData {
        WireFormat.IDENTIFIER.require(id, "id");
        WireFormat.KEY.requireOrNull(operationKey, "operationKey");
        Objects.requireNonNull(kind, "kind");
        Objects.requireNonNull(state, "state");
        WireFormat.TARGET.requireOrNull(targetId, "targetId");
        WireFormat.DIGEST.requireOrNull(targetRevision, "targetRevision");
        WireNumber.NON_NEGATIVE.require(createdAt, "createdAt");
        WireNumber.NON_NEGATIVE.requireOrNull(expiresAt, "expiresAt");
        WireNumber.NON_NEGATIVE.requireOrNull(finishedAt, "finishedAt");
    }
}
