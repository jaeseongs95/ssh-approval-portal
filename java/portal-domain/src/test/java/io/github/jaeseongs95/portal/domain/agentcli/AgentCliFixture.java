package io.github.jaeseongs95.portal.domain.agentcli;

import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;

import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/**
 * The fixed inputs of the 2.x test {@code agent-cli.test.mjs} (target alpha, profile ssh-write, an integrity of 64 bytes of 7, now 1000, expiry 1001), written
 * as plain instance members. The tarball address is rebuilt here from the 2.x rule, not taken from the production code, so a wrong rule in the code fails a test.
 */
final class AgentCliFixture {

    final Digester digester = new Sha256Digester();
    final AgentCliProvider codex = new CodexCliProvider();
    final AgentCliProvider claude = new ClaudeCliProvider();
    final String integrity = integrityOf(7);
    final TargetId targetId = new TargetId("alpha");
    final TargetRevision revision = new TargetRevision(new Digest("a".repeat(64)));
    final ProfileAlias profile = new ProfileAlias("ssh-write");
    final AgentCliTargetBinding binding = new AgentCliTargetBinding(targetId, revision, profile, true);
    final Digest installed = new Digest("b".repeat(64));
    final Instant now = Instant.ofEpochMilli(1000);
    final Instant expiry = Instant.ofEpochMilli(1001);

    /** {@code sha512-} and the base64 of 64 bytes that all have the given value. */
    String integrityOf(int fill) {
        byte[] bytes = new byte[64];
        Arrays.fill(bytes, (byte) fill);
        return "sha512-" + Base64.getEncoder().encodeToString(bytes);
    }

    String tarball(AgentCliProvider provider, String version) {
        String name = provider.packageName();
        return "https://registry.npmjs.org/" + name + "/-/" + name.substring(name.indexOf('/') + 1) + "-" + version + ".tgz";
    }

    AgentCliProvider provider(AgentCliProviderId id) {
        return switch (id) {
            case CODEX -> codex;
            case CLAUDE -> claude;
        };
    }

    AgentRelease release(AgentCliProvider provider, String version) {
        return release(provider, version, integrity);
    }

    AgentRelease release(AgentCliProvider provider, String version, String integrityText) {
        return AgentRelease.verify(provider, provider.packageName(), version, tarball(provider, version), integrityText, digester);
    }

    /** A request key of 22 characters: {@code cli-request-fixed-0001}, {@code …0002}. */
    RequestKey key(int number) {
        return new RequestKey("cli-request-fixed-000" + number);
    }

    AgentCliRequest request(AgentRelease release, AgentCliAction action, RequestKey key, Digest installedRevision) {
        return new AgentCliRequest(targetId, revision, profile, release.provider(), action, release.releaseDigestLabel(), installedRevision, key);
    }

    AgentCliIntent intent(AgentCliProvider provider, AgentCliRequest request, AgentRelease release, Instant expiresAt) {
        return AgentCliIntent.of(provider, request, binding, release, expiresAt, now, digester);
    }
}
