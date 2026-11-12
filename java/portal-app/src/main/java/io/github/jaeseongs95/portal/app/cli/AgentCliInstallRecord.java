package io.github.jaeseongs95.portal.app.cli;

import java.time.Instant;
import java.util.Objects;
import java.util.regex.Pattern;

import io.github.jaeseongs95.portal.domain.agentcli.AgentCliAction;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProviderId;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.OperationId;

/**
 * What is stored of an operation of kind {@code AGENT_CLI} besides the operation row itself (the common part): the pinned release, the digest of the intent that the
 * owner approved, the time the plan expires and the status the target reported. The domain's {@code AgentCliRequest} is the intent that arrives; this is what the
 * store keeps of it.
 */
public record AgentCliInstallRecord(OperationId operationId, AgentCliProviderId provider, AgentCliAction action, AgentRelease release, Digest expectedInstallationRevision,
                                    String intentDigest, Instant planExpiresAt, RemoteStatus remote) {

    private static final Pattern INTENT_DIGEST = Pattern.compile("sha256:[a-f0-9]{64}");

    public AgentCliInstallRecord {
        Objects.requireNonNull(operationId, "operationId");
        Objects.requireNonNull(provider, "provider");
        Objects.requireNonNull(action, "action");
        Objects.requireNonNull(release, "release");
        Objects.requireNonNull(expectedInstallationRevision, "expectedInstallationRevision");
        Objects.requireNonNull(intentDigest, "intentDigest");
        Objects.requireNonNull(planExpiresAt, "planExpiresAt");
        Objects.requireNonNull(remote, "remote");
        if (release.provider() != provider) {
            throw new IllegalArgumentException("The release is of another provider");
        }
        if (!INTENT_DIGEST.matcher(intentDigest).matches()) {
            throw new IllegalArgumentException("An intent digest is sha256: and 64 lowercase hex characters");
        }
    }
}
