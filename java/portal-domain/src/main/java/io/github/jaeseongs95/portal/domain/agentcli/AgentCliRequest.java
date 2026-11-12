package io.github.jaeseongs95.portal.domain.agentcli;

import java.util.Objects;
import java.util.regex.Pattern;

import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/**
 * What the administrator submits to install or update an agent tool: exactly these eight fields (2.x agent-cli.mjs:37). The record has no place for a command, a
 * package name or an address, so none can be passed; JSON with an extra field is refused where it is read (strict binding in the web module).
 * The release digest is the {@code sha256:} text the preview showed; {@link AgentCliIntent#of} compares it with the release plan.
 */
public record AgentCliRequest(TargetId targetId, TargetRevision targetRevision, ProfileAlias profile, AgentCliProviderId provider, AgentCliAction action,
        String releaseDigest, Digest expectedInstallationRevision, RequestKey requestKey) {

    private static final Pattern RELEASE_DIGEST = Pattern.compile("sha256:[a-f0-9]{64}");

    public AgentCliRequest {
        Objects.requireNonNull(targetId, "targetId");
        Objects.requireNonNull(targetRevision, "targetRevision");
        Objects.requireNonNull(profile, "profile");
        Objects.requireNonNull(provider, "provider");
        Objects.requireNonNull(action, "action");
        Objects.requireNonNull(releaseDigest, "releaseDigest");
        Objects.requireNonNull(expectedInstallationRevision, "expectedInstallationRevision");
        Objects.requireNonNull(requestKey, "requestKey");
        if (!RELEASE_DIGEST.matcher(releaseDigest).matches()) {
            throw new IllegalArgumentException("A release digest is sha256: and 64 lowercase hex characters");
        }
    }

    /** Whether the request was made for this very target, revision and profile; a request for an older revision or another profile is stale. */
    public boolean targets(AgentCliTargetBinding binding) {
        return targetId.equals(binding.targetId()) && targetRevision.equals(binding.targetRevision()) && profile.equals(binding.profile());
    }
}
