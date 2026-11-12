package io.github.jaeseongs95.portal.domain.agentcli;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.lang.reflect.RecordComponent;
import java.util.Arrays;
import java.util.Base64;
import java.util.stream.Stream;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * The checks of a release the registry announced (2.x agent-cli.test.mjs:17-27). The metadata is untrusted text, so every case below is a text that must be
 * refused. The 2.x cases that pass a JSON object with extra fields cannot be written here: the factory takes the four public fields as arguments, so a private
 * field has no place to enter (the test of the record components shows it).
 */
class AgentReleaseTest {

    private final AgentCliFixture fx = new AgentCliFixture();

    @ParameterizedTest(name = "[{index}] {0}")
    @EnumSource(AgentCliProviderId.class)
    @DisplayName("RC-A-089 the official public release of each provider is kept as the six public fields")
    void keepsOnlyThePublicFields(AgentCliProviderId id) {
        AgentCliProvider provider = fx.provider(id);

        AgentRelease release = fx.release(provider, "1.2.3");
        AgentRelease again = fx.release(provider, "1.2.3");

        assertThat(release).isEqualTo(again);
        assertThat(release.provider()).isEqualTo(id);
        assertThat(release.packageName()).isEqualTo(provider.packageName());
        assertThat(release.version()).isEqualTo("1.2.3");
        assertThat(release.tarball()).isEqualTo(fx.tarball(provider, "1.2.3"));
        assertThat(release.digestMatches(fx.digester)).isTrue();
        assertThat(release.toString()).doesNotContain("private");
        assertThat(Arrays.stream(AgentRelease.class.getRecordComponents()).map(RecordComponent::getName).toList())
                .containsExactly("provider", "packageName", "version", "tarball", "integrity", "releaseDigest");
    }

    @Test
    @DisplayName("S2-AG-02 the release digest is the SHA-256 of the fixed JSON of the five fields (the 2.x recipe)")
    void releaseDigestHasAFixedVector() {
        AgentRelease release = fx.release(fx.codex, "1.2.3");

        // The vector was made once outside Java: sha256sum over the 2.x JSON.stringify bytes of {provider,packageName,version,tarball,integrity}.
        assertThat(release.releaseDigest().hex()).isEqualTo("d5cdb0b59c055bb3bce0707045aaf1332bc71075c0c6358734ce6ffbbfeb570f");
        assertThat(release.releaseDigestLabel()).isEqualTo("sha256:d5cdb0b59c055bb3bce0707045aaf1332bc71075c0c6358734ce6ffbbfeb570f");
        assertThat(fx.release(fx.codex, "1.2.4").releaseDigest()).isNotEqualTo(release.releaseDigest());
        assertThat(fx.release(fx.claude, "1.2.3").releaseDigest()).isNotEqualTo(release.releaseDigest());
    }

    @ParameterizedTest(name = "[{index}] {0}")
    @ValueSource(strings = {"latest", "^1.2.3", "1.2", "01.2.3", "1.2.3-rc.1", "1.2.3+build", "1.2.3;id", "1.2.3\n", "9999999.2.3", "../../etc"})
    @DisplayName("RC-A-090 an unstable or unbounded version is refused")
    void refusesVersionsThatAreNotStable(String version) {
        assertThatThrownBy(() -> fx.release(fx.codex, version)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S2-AG-03 the largest version of six digits per part and zero parts are accepted")
    void acceptsTheVersionBounds() {
        assertThat(fx.release(fx.codex, "999999.999999.999999").version()).isEqualTo("999999.999999.999999");
        assertThat(fx.release(fx.codex, "0.0.0").version()).isEqualTo("0.0.0");
    }

    @ParameterizedTest(name = "[{index}] {0}")
    @ValueSource(strings = {
        "http://registry.npmjs.org/@openai/codex/-/codex-1.2.3.tgz",
        "https://evil.test/@openai/codex/-/codex-1.2.3.tgz",
        "https://registry.npmjs.org.evil.test/@openai/codex/-/codex-1.2.3.tgz",
        "https://u:p@registry.npmjs.org/@openai/codex/-/codex-1.2.3.tgz",
        "https://registry.npmjs.org:444/@openai/codex/-/codex-1.2.3.tgz",
        "https://registry.npmjs.org/@openai/codex/-/codex-1.2.3.tgz?token=private",
        "https://registry.npmjs.org/@openai/codex/-/codex-1.2.3.tgz#part",
        "https://registry.npmjs.org/@openai/codex/-/other.tgz"})
    @DisplayName("RC-A-091 an alternative distribution address is refused")
    void refusesAlternativeDistribution(String tarball) {
        assertThatThrownBy(() -> AgentRelease.verify(fx.codex, "@openai/codex", "1.2.3", tarball, fx.integrity, fx.digester))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("RC-A-092 metadata of another package, or with a missing part, is refused")
    void refusesMalformedMetadata() {
        String tarball = fx.tarball(fx.codex, "1.2.3");

        assertThatThrownBy(() -> AgentRelease.verify(fx.codex, "@other/codex", "1.2.3", tarball, fx.integrity, fx.digester))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AgentRelease.verify(fx.codex, null, "1.2.3", tarball, fx.integrity, fx.digester)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> AgentRelease.verify(fx.codex, "@openai/codex", null, tarball, fx.integrity, fx.digester)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> AgentRelease.verify(fx.codex, "@openai/codex", "1.2.3", null, fx.integrity, fx.digester)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> AgentRelease.verify(fx.codex, "@openai/codex", "1.2.3", tarball, null, fx.digester)).isInstanceOf(NullPointerException.class);
    }

    @ParameterizedTest(name = "[{index}] {0}")
    @MethodSource("badIntegrities")
    @DisplayName("RC-A-092 a checksum that is not exactly sha512 of 64 bytes in canonical base64 is refused")
    void refusesBadChecksums(String integrity) {
        assertThatThrownBy(() -> fx.release(fx.codex, "1.2.3", integrity)).isInstanceOf(IllegalArgumentException.class);
    }

    static Stream<String> badIntegrities() {
        String valid = "sha512-" + Base64.getEncoder().encodeToString(sevens(64));
        return Stream.of(
            "sha1-abcd",
            "sha512-" + Base64.getEncoder().encodeToString(sevens(63)),
            "sha512-" + Base64.getEncoder().encodeToString(sevens(65)),
            valid + " ",
            valid.substring(0, valid.length() - 3) + "B==",
            "");
    }

    private static byte[] sevens(int length) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, (byte) 7);
        return bytes;
    }

    @Test
    @DisplayName("S2-AG-04 a release whose five fields were edited no longer matches its digest")
    void detectsAnEditedRelease() {
        AgentRelease original = fx.release(fx.codex, "1.2.3");
        AgentRelease edited = new AgentRelease(original.provider(), original.packageName(), "1.2.4", fx.tarball(fx.codex, "1.2.4"), original.integrity(),
                original.releaseDigest());

        assertThat(original.digestMatches(fx.digester)).isTrue();
        assertThat(edited.digestMatches(fx.digester)).isFalse();
    }
}
