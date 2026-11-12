package io.github.jaeseongs95.portal.domain.agentcli;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.lang.reflect.RecordComponent;
import java.time.Instant;
import java.util.Arrays;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/** The fixed installation intent (2.x agent-cli.test.mjs:31-55). The clock is an argument, so the expiry boundary needs no real time. */
class AgentCliIntentTest {

    private static final long MAX_SAFE_MILLIS = 9_007_199_254_740_991L;

    private final AgentCliFixture fx = new AgentCliFixture();

    @Test
    @DisplayName("RC-A-093 the intent digest binds release, action, installation snapshot and expiry, but not the request key")
    void digestBindsWhatIsInstalledAndNotTheRequestKey() {
        AgentRelease release = fx.release(fx.codex, "1.2.3");
        AgentCliIntent first = fx.intent(fx.codex, fx.request(release, AgentCliAction.INSTALL, fx.key(1), fx.installed), release, fx.expiry);

        assertThat(AgentCliIntent.CONTRACT).isEqualTo("agent-cli-install-v1");
        assertThat(first.expiresAt()).isEqualTo(Instant.ofEpochMilli(1001));

        AgentCliIntent otherKey = fx.intent(fx.codex, fx.request(release, AgentCliAction.INSTALL, fx.key(2), fx.installed), release, fx.expiry);
        assertThat(otherKey.intentDigest()).isEqualTo(first.intentDigest());
        assertThat(otherKey.requestKey()).isNotEqualTo(first.requestKey());

        AgentCliIntent update = fx.intent(fx.codex, fx.request(release, AgentCliAction.UPDATE, fx.key(1), fx.installed), release, fx.expiry);
        assertThat(update.intentDigest()).isNotEqualTo(first.intentDigest());

        AgentCliIntent otherInstallation = fx.intent(fx.codex, fx.request(release, AgentCliAction.INSTALL, fx.key(1), new Digest("c".repeat(64))), release, fx.expiry);
        assertThat(otherInstallation.intentDigest()).isNotEqualTo(first.intentDigest());

        AgentCliIntent laterExpiry = fx.intent(fx.codex, fx.request(release, AgentCliAction.INSTALL, fx.key(1), fx.installed), release, Instant.ofEpochMilli(1002));
        assertThat(laterExpiry.intentDigest()).isNotEqualTo(first.intentDigest());

        AgentRelease next = fx.release(fx.codex, "1.2.4");
        AgentCliIntent nextRelease = fx.intent(fx.codex, fx.request(next, AgentCliAction.INSTALL, fx.key(1), fx.installed), next, fx.expiry);
        assertThat(nextRelease.intentDigest()).isNotEqualTo(first.intentDigest());
        assertThat(nextRelease.releaseDigest()).isEqualTo(next.releaseDigest());
    }

    @Test
    @DisplayName("S2-AG-05 the intent digest is the SHA-256 of the fixed JSON of the nine fields, key order as in 2.x")
    void digestHasTheFixedJsonForm() {
        AgentRelease release = fx.release(fx.codex, "1.2.3");
        AgentCliIntent intent = fx.intent(fx.codex, fx.request(release, AgentCliAction.INSTALL, fx.key(1), fx.installed), release, fx.expiry);

        String json = "{\"contract\":\"agent-cli-install-v1\",\"targetId\":\"alpha\",\"targetRevision\":\"" + "a".repeat(64)
                + "\",\"profile\":\"ssh-write\",\"provider\":\"codex\",\"action\":\"install\",\"releaseDigest\":\"sha256:" + release.releaseDigest().hex()
                + "\",\"expectedInstallationRevision\":\"" + "b".repeat(64) + "\",\"expiresAt\":1001}";

        assertThat(intent.intentDigest()).isEqualTo(fx.digester.digestUtf8(json));
        assertThat(intent.targetId()).isEqualTo(fx.targetId);
        assertThat(intent.provider()).isEqualTo(AgentCliProviderId.CODEX);
        assertThat(intent.action()).isEqualTo(AgentCliAction.INSTALL);
        assertThat(intent.expectedInstallationRevision()).isEqualTo(fx.installed);
    }

    @Test
    @DisplayName("RC-A-094 a request for another target, revision or profile is refused as stale")
    void refusesAStaleTarget() {
        AgentRelease release = fx.release(fx.codex, "1.2.3");
        String label = release.releaseDigestLabel();
        AgentCliRequest otherTarget = new AgentCliRequest(new TargetId("beta"), fx.revision, fx.profile, AgentCliProviderId.CODEX, AgentCliAction.INSTALL, label,
                fx.installed, fx.key(1));
        AgentCliRequest otherRevision = new AgentCliRequest(fx.targetId, new TargetRevision(new Digest("f".repeat(64))), fx.profile, AgentCliProviderId.CODEX,
                AgentCliAction.INSTALL, label, fx.installed, fx.key(1));
        AgentCliRequest otherProfile = new AgentCliRequest(fx.targetId, fx.revision, new ProfileAlias("other"), AgentCliProviderId.CODEX,
                AgentCliAction.INSTALL, label, fx.installed, fx.key(1));

        assertThatThrownBy(() -> fx.intent(fx.codex, otherTarget, release, fx.expiry)).as("target").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> fx.intent(fx.codex, otherRevision, release, fx.expiry)).as("revision").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> fx.intent(fx.codex, otherProfile, release, fx.expiry)).as("profile").isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("RC-A-094 a disabled target, a target id with a path, a revision that is no digest and a profile with a separator are refused")
    void refusesADisabledOrMalformedBinding() {
        AgentRelease release = fx.release(fx.codex, "1.2.3");
        AgentCliRequest request = fx.request(release, AgentCliAction.INSTALL, fx.key(1), fx.installed);
        AgentCliTargetBinding disabled = new AgentCliTargetBinding(fx.targetId, fx.revision, fx.profile, false);

        assertThatThrownBy(() -> AgentCliIntent.of(fx.codex, request, disabled, release, fx.expiry, fx.now, fx.digester)).as("disabled")
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TargetId("../server")).as("target id").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TargetRevision(new Digest("not-a-revision"))).as("revision").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ProfileAlias("x;id")).as("profile").isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("RC-A-094 a request for a provider other than the one the intent is made for is refused")
    void refusesAnotherProvider() {
        AgentRelease release = fx.release(fx.codex, "1.2.3");
        AgentCliRequest request = fx.request(release, AgentCliAction.INSTALL, fx.key(1), fx.installed);

        assertThatThrownBy(() -> fx.intent(fx.claude, request, release, fx.expiry)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("RC-A-095 the request has exactly the eight fields, and the action and provider are closed sets")
    void requestHasExactlyEightFields() {
        assertThat(Arrays.stream(AgentCliRequest.class.getRecordComponents()).map(RecordComponent::getName).toList())
                .containsExactly("targetId", "targetRevision", "profile", "provider", "action", "releaseDigest", "expectedInstallationRevision", "requestKey");
        // Extra fields (command, packageName, url) are refused where the JSON becomes a request: the record has no place for them.
        assertThatThrownBy(() -> AgentCliAction.parse("uninstall")).as("action").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AgentCliProviderId.parse("constructor")).as("provider").isInstanceOf(IllegalArgumentException.class);
        assertThat(AgentCliAction.parse("install")).isEqualTo(AgentCliAction.INSTALL);
        assertThat(AgentCliAction.parse("update")).isEqualTo(AgentCliAction.UPDATE);
    }

    @Test
    @DisplayName("RC-A-095 a request key that is too short or too long, or a missing installation revision, is refused")
    void refusesMalformedRequestFields() {
        AgentRelease release = fx.release(fx.codex, "1.2.3");

        assertThatThrownBy(() -> new RequestKey("short")).as("short key").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new RequestKey("x".repeat(129))).as("long key").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AgentCliRequest(fx.targetId, fx.revision, fx.profile, AgentCliProviderId.CODEX, AgentCliAction.INSTALL,
                release.releaseDigestLabel(), null, fx.key(1))).as("installation revision").isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new AgentCliRequest(fx.targetId, fx.revision, fx.profile, AgentCliProviderId.CODEX, AgentCliAction.INSTALL,
                "sha256:short", fx.installed, fx.key(1))).as("release digest").isInstanceOf(IllegalArgumentException.class);
    }

    @ParameterizedTest(name = "[{index}] field {0} missing")
    @ValueSource(ints = {0, 1, 2, 3, 4, 5, 6, 7})
    @DisplayName("RC-A-095 a request with any one of the eight fields missing is refused")
    void refusesAMissingField(int missing) {
        String label = fx.release(fx.codex, "1.2.3").releaseDigestLabel();

        assertThatThrownBy(() -> new AgentCliRequest(
                missing == 0 ? null : fx.targetId,
                missing == 1 ? null : fx.revision,
                missing == 2 ? null : fx.profile,
                missing == 3 ? null : AgentCliProviderId.CODEX,
                missing == 4 ? null : AgentCliAction.INSTALL,
                missing == 5 ? null : label,
                missing == 6 ? null : fx.installed,
                missing == 7 ? null : fx.key(1))).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("RC-A-095 no request at all is refused")
    void refusesNoRequest() {
        AgentRelease release = fx.release(fx.codex, "1.2.3");

        assertThatThrownBy(() -> AgentCliIntent.of(fx.codex, null, fx.binding, release, fx.expiry, fx.now, fx.digester)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("RC-A-096 a release whose digest, version, provider, integrity or distribution address was changed is detected")
    void detectsATamperedRelease() {
        AgentRelease original = fx.release(fx.codex, "1.2.3");
        AgentCliRequest request = fx.request(original, AgentCliAction.INSTALL, fx.key(1), fx.installed);

        AgentRelease otherDigest = new AgentRelease(original.provider(), original.packageName(), original.version(), original.tarball(), original.integrity(),
                new Digest("f".repeat(64)));
        AgentRelease otherVersion = new AgentRelease(original.provider(), original.packageName(), "1.2.4", fx.tarball(fx.codex, "1.2.4"), original.integrity(),
                original.releaseDigest());
        AgentRelease otherProvider = new AgentRelease(AgentCliProviderId.CLAUDE, original.packageName(), original.version(), original.tarball(),
                original.integrity(), original.releaseDigest());
        AgentRelease otherIntegrity = new AgentRelease(original.provider(), original.packageName(), original.version(), original.tarball(),
                fx.integrityOf(8), original.releaseDigest());

        assertThatThrownBy(() -> fx.intent(fx.codex, request, otherDigest, fx.expiry)).as("digest").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> fx.intent(fx.codex, request, otherVersion, fx.expiry)).as("version").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> fx.intent(fx.codex, request, otherProvider, fx.expiry)).as("provider").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> fx.intent(fx.codex, request, otherIntegrity, fx.expiry)).as("integrity").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AgentRelease(original.provider(), original.packageName(), original.version(), "https://evil.test/code.tgz",
                original.integrity(), original.releaseDigest())).as("tarball").isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("RC-A-096 a request that names a different release digest is refused")
    void detectsATamperedRequestDigest() {
        AgentRelease release = fx.release(fx.codex, "1.2.3");
        AgentCliRequest request = new AgentCliRequest(fx.targetId, fx.revision, fx.profile, AgentCliProviderId.CODEX, AgentCliAction.INSTALL,
                "sha256:" + "f".repeat(64), fx.installed, fx.key(1));

        assertThatThrownBy(() -> fx.intent(fx.codex, request, release, fx.expiry)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("RC-A-097 an expiry one millisecond after now is accepted and an expiry at or before now is refused, with no epsilon")
    void expiryBoundaryHasNoEpsilon() {
        AgentRelease release = fx.release(fx.codex, "1.2.3");
        AgentCliRequest request = fx.request(release, AgentCliAction.INSTALL, fx.key(1), fx.installed);

        assertThatCode(() -> fx.intent(fx.codex, request, release, Instant.ofEpochMilli(1001))).doesNotThrowAnyException();
        assertThatThrownBy(() -> fx.intent(fx.codex, request, release, Instant.ofEpochMilli(1000))).as("expiry equals now").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> fx.intent(fx.codex, request, release, Instant.ofEpochMilli(999))).as("expiry before now").isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("RC-A-097 a missing expiry or a missing clock reading is refused")
    void refusesAMissingTime() {
        AgentRelease release = fx.release(fx.codex, "1.2.3");
        AgentCliRequest request = fx.request(release, AgentCliAction.INSTALL, fx.key(1), fx.installed);

        assertThatThrownBy(() -> AgentCliIntent.of(fx.codex, request, fx.binding, release, null, fx.now, fx.digester)).as("expiry").isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> AgentCliIntent.of(fx.codex, request, fx.binding, release, fx.expiry, null, fx.digester)).as("now").isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("RC-A-097 an expiry beyond the largest integer a JavaScript client reads exactly is refused")
    void refusesAnExpiryBeyondTheSafeInteger() {
        AgentRelease release = fx.release(fx.codex, "1.2.3");
        AgentCliRequest request = fx.request(release, AgentCliAction.INSTALL, fx.key(1), fx.installed);

        assertThatCode(() -> fx.intent(fx.codex, request, release, Instant.ofEpochMilli(MAX_SAFE_MILLIS))).doesNotThrowAnyException();
        assertThatThrownBy(() -> fx.intent(fx.codex, request, release, Instant.ofEpochMilli(MAX_SAFE_MILLIS + 1))).isInstanceOf(IllegalArgumentException.class);
    }
}
