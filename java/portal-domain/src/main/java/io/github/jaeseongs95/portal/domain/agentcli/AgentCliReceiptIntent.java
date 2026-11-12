package io.github.jaeseongs95.portal.domain.agentcli;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Digester;

/**
 * What the target-side helper receives and reports back as its receipt: action, provider, version, checksum, the installation snapshot the plan expects and the
 * expiry (2.x adapters/ssh/agent-cli.mjs {@code receiptDigest}). The helper computes the SHA-256 of {@link #canonicalJson()} itself and returns it, and the
 * portal compares the two. The byte form is therefore a contract with the helper and must not change: keys sorted by name, no spaces, one line feed at the end.
 */
public record AgentCliReceiptIntent(AgentCliAction action, AgentRelease release, Digest expectedInstallationRevision, Instant expiresAt) {

    public AgentCliReceiptIntent {
        Objects.requireNonNull(action, "action");
        Objects.requireNonNull(release, "release");
        Objects.requireNonNull(expectedInstallationRevision, "expectedInstallationRevision");
        Objects.requireNonNull(expiresAt, "expiresAt");
        expiresAt = expiresAt.truncatedTo(ChronoUnit.MILLIS);
        if (!expiresAt.isAfter(Instant.EPOCH) || expiresAt.isAfter(AgentCliIntent.LATEST_EXPIRY)) {
            throw new IllegalArgumentException("A CLI receipt expiry is after the epoch and not beyond 2^53-1 milliseconds");
        }
    }

    /**
     * The JSON text that is hashed. The fields are validated types without characters that JSON escapes, so concatenation gives the bytes {@code JSON.stringify}
     * gave in 2.x. The epoch milliseconds are written as a plain integer.
     */
    public String canonicalJson() {
        return "{\"action\":\"" + action.wire() + "\",\"expected\":\"" + expectedInstallationRevision.hex() + "\",\"expires\":" + expiresAt.toEpochMilli()
                + ",\"integrity\":\"" + release.integrity() + "\",\"provider\":\"" + release.provider().wire() + "\",\"version\":\"" + release.version()
                + "\"}\n";
    }

    public Digest digest(Digester digester) {
        Objects.requireNonNull(digester, "digester");
        return digester.digestUtf8(canonicalJson());
    }
}
