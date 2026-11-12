package io.github.jaeseongs95.portal.app.agentcli;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/**
 * One approved installation that the dispatcher hands over to run: the operation (whose install record the {@code AgentCliRequestStore} keeps), the request key it was
 * accepted under, the target as it is configured now, and the revision and the profile the operation was approved for. The use case compares the last two with the
 * target before it fetches or sends anything.
 *
 * @param operation the accepted operation of kind {@code AGENT_CLI}
 * @param requestKey the key the operation was accepted under
 * @param target the target as configured now
 * @param approvedRevision the revision the operation was approved for
 * @param approvedProfile the profile the operation was approved for
 */
public record AgentCliRun(OperationId operation, RequestKey requestKey, ResolvedTarget target, TargetRevision approvedRevision, ProfileAlias approvedProfile) {

    public AgentCliRun {
        Objects.requireNonNull(operation, "operation");
        Objects.requireNonNull(requestKey, "requestKey");
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(approvedRevision, "approvedRevision");
        Objects.requireNonNull(approvedProfile, "approvedProfile");
    }
}
