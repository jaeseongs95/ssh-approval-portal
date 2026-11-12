package io.github.jaeseongs95.portal.domain.agentcli;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/**
 * A fixed intent: what is to be installed, where and until when (2.x agent-cli.mjs:36-51). It binds the target, its revision and profile, the release, the action
 * and the installation snapshot the administrator saw. It never grants the right to run anything. The {@code intentDigest} covers all of that and the expiry but
 * not the request key, so the same install sent again with a new key is the same intent.
 *
 * <p>The record only checks that its parts exist; {@link #of} is the place that checks the request against the current target and the release plan.
 */
public record AgentCliIntent(TargetId targetId, TargetRevision targetRevision, ProfileAlias profile, AgentCliProviderId provider, AgentCliAction action,
        Digest releaseDigest, Digest expectedInstallationRevision, Instant expiresAt, Digest intentDigest, RequestKey requestKey) {

    /** The contract name that is part of every intent digest (2.x agent-cli.mjs:3). */
    public static final String CONTRACT = "agent-cli-install-v1";

    /** The last instant whose epoch milliseconds a JavaScript client still reads exactly (2^53-1); a later expiry is refused, as in 2.x. */
    static final Instant LATEST_EXPIRY = Instant.ofEpochMilli(9_007_199_254_740_991L);

    public AgentCliIntent {
        Objects.requireNonNull(targetId, "targetId");
        Objects.requireNonNull(targetRevision, "targetRevision");
        Objects.requireNonNull(profile, "profile");
        Objects.requireNonNull(provider, "provider");
        Objects.requireNonNull(action, "action");
        Objects.requireNonNull(releaseDigest, "releaseDigest");
        Objects.requireNonNull(expectedInstallationRevision, "expectedInstallationRevision");
        Objects.requireNonNull(expiresAt, "expiresAt");
        Objects.requireNonNull(intentDigest, "intentDigest");
        Objects.requireNonNull(requestKey, "requestKey");
    }

    /**
     * Checks the request against the target as it stands, the release plan and the clock, and returns the intent. The expiry must lie after {@code now}: an
     * expiry equal to {@code now} is expired, and nothing is added to or taken from it. The time is an argument, so the caller's {@code Clock} decides.
     *
     * @param provider the provider the request names, taken from the catalog
     * @throws IllegalArgumentException when the target is disabled or changed, the release plan is not the one the request names or was altered, or the plan expired
     */
    public static AgentCliIntent of(AgentCliProvider provider, AgentCliRequest request, AgentCliTargetBinding binding, AgentRelease release, Instant expiresAt,
            Instant now, Digester digester) {
        Objects.requireNonNull(provider, "provider");
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(binding, "binding");
        Objects.requireNonNull(release, "release");
        Objects.requireNonNull(expiresAt, "expiresAt");
        Objects.requireNonNull(now, "now");
        Objects.requireNonNull(digester, "digester");
        if (provider.id() != request.provider()) {
            throw new IllegalArgumentException("Unsupported CLI provider");
        }
        if (!binding.enabled()) {
            throw new IllegalArgumentException("Invalid CLI target binding");
        }
        if (!request.targets(binding)) {
            throw new IllegalArgumentException("Stale CLI target binding");
        }
        if (release.provider() != request.provider() || !release.packageName().equals(provider.packageName()) || !release.digestMatches(digester)
                || !request.releaseDigest().equals(release.releaseDigestLabel())) {
            throw new IllegalArgumentException("CLI release plan changed");
        }
        Instant expiry = expiresAt.truncatedTo(ChronoUnit.MILLIS);
        if (!expiry.isAfter(now) || expiry.isAfter(LATEST_EXPIRY)) {
            throw new IllegalArgumentException("CLI release plan expired");
        }
        String json = "{\"contract\":\"" + CONTRACT + "\",\"targetId\":\"" + request.targetId().value() + "\",\"targetRevision\":\""
                + request.targetRevision().value().hex() + "\",\"profile\":\"" + request.profile().value() + "\",\"provider\":\"" + request.provider().wire()
                + "\",\"action\":\"" + request.action().wire() + "\",\"releaseDigest\":\"" + release.releaseDigestLabel()
                + "\",\"expectedInstallationRevision\":\"" + request.expectedInstallationRevision().hex() + "\",\"expiresAt\":" + expiry.toEpochMilli() + "}";
        return new AgentCliIntent(request.targetId(), request.targetRevision(), request.profile(), request.provider(), request.action(),
                release.releaseDigest(), request.expectedInstallationRevision(), expiry, digester.digestUtf8(json), request.requestKey());
    }
}
