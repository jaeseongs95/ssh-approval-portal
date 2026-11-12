package io.github.jaeseongs95.portal.domain.agentcli;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/**
 * The target an installation is bound to, as the administrator's configuration stands now: which target, which revision of it, which profile runs the commands
 * and whether the target is enabled (2.x agent-cli.mjs:40). The application reads it when a request arrives; a request made for an older revision is stale.
 */
public record AgentCliTargetBinding(TargetId targetId, TargetRevision targetRevision, ProfileAlias profile, boolean enabled) {

    public AgentCliTargetBinding {
        Objects.requireNonNull(targetId, "targetId");
        Objects.requireNonNull(targetRevision, "targetRevision");
        Objects.requireNonNull(profile, "profile");
    }
}
