package io.github.jaeseongs95.portal.domain.agentcli;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.domain.id.Digest;

/**
 * The digest the target-side helper reports back as its receipt (2.x adapters/ssh/agent-cli.mjs {@code receiptDigest}): SHA-256 over the keys-sorted JSON of
 * six fields and one line feed. The helper on the target computes the same bytes, so the form is a fixed contract and the vectors below must not change.
 */
class AgentCliReceiptIntentTest {

    private final AgentCliFixture fx = new AgentCliFixture();

    @Test
    @DisplayName("RC-A-907 the receipt digest of the fixed install plan equals the SHA-256 vector made from the 2.x canonical JSON")
    void digestMatchesTheFixedVector() {
        AgentRelease release = fx.release(fx.codex, "1.2.3");
        AgentCliReceiptIntent receipt = new AgentCliReceiptIntent(AgentCliAction.INSTALL, release, fx.installed, Instant.ofEpochMilli(301_000));

        String expected = "{\"action\":\"install\",\"expected\":\"" + "b".repeat(64) + "\",\"expires\":301000,\"integrity\":\"" + fx.integrity
                + "\",\"provider\":\"codex\",\"version\":\"1.2.3\"}\n";
        assertThat(receipt.canonicalJson()).isEqualTo(expected);
        // The vector was made once outside Java (sha256sum over the 2.x bytes: sorted keys, no spaces, one line feed). A-907 asked for a vector instead of Python.
        assertThat(receipt.digest(fx.digester).hex()).isEqualTo("4dd94c852bbbd6ad466784c40b4c0ff170c206cf44bd127bafe0072db9026b41");
        assertThat(receipt.digest(fx.digester)).isEqualTo(fx.digester.digestUtf8(expected));
    }

    @Test
    @DisplayName("RC-B-552 the receipt digest puts expected before expires and ends with one line feed")
    void digestHasTheFixedKeyOrderAndLineFeed() {
        String zeroIntegrity = fx.integrityOf(0);
        AgentRelease release = fx.release(fx.codex, "1.2.3", zeroIntegrity);
        AgentCliReceiptIntent receipt = new AgentCliReceiptIntent(AgentCliAction.INSTALL, release, fx.installed, Instant.ofEpochMilli(1_900_000_000_000L));

        String canonical = "{\"action\":\"install\",\"expected\":\"" + "b".repeat(64) + "\",\"expires\":1900000000000,\"integrity\":\"" + zeroIntegrity
                + "\",\"provider\":\"codex\",\"version\":\"1.2.3\"}\n";
        assertThat(receipt.canonicalJson()).isEqualTo(canonical).endsWith("}\n");
        assertThat(receipt.digest(fx.digester)).isEqualTo(fx.digester.digestUtf8(canonical));
        assertThat(receipt.digest(fx.digester).hex()).isEqualTo("396b246a8a861cf72255060d81e439d09d4f0dee2dfeb2e3bdcd150fe1563578");
    }

    @Test
    @DisplayName("S2-AG-06 the receipt digest changes with the action, the provider, the installation snapshot and the expiry")
    void digestChangesWithEveryField() {
        AgentRelease release = fx.release(fx.codex, "1.2.3");
        Instant expires = Instant.ofEpochMilli(301_000);
        Digest base = new AgentCliReceiptIntent(AgentCliAction.INSTALL, release, fx.installed, expires).digest(fx.digester);

        assertThat(new AgentCliReceiptIntent(AgentCliAction.UPDATE, release, fx.installed, expires).digest(fx.digester)).isNotEqualTo(base);
        assertThat(new AgentCliReceiptIntent(AgentCliAction.INSTALL, fx.release(fx.claude, "1.2.3"), fx.installed, expires).digest(fx.digester)).isNotEqualTo(base);
        assertThat(new AgentCliReceiptIntent(AgentCliAction.INSTALL, release, new Digest("c".repeat(64)), expires).digest(fx.digester)).isNotEqualTo(base);
        assertThat(new AgentCliReceiptIntent(AgentCliAction.INSTALL, release, fx.installed, expires.plusMillis(1)).digest(fx.digester)).isNotEqualTo(base);
        assertThat(new AgentCliReceiptIntent(AgentCliAction.INSTALL, release, fx.installed, expires).digest(fx.digester)).isEqualTo(base);
    }

    @Test
    @DisplayName("S2-AG-07 an expiry at the epoch or beyond the safe integer, and missing parts, are refused")
    void refusesInvalidParts() {
        AgentRelease release = fx.release(fx.codex, "1.2.3");

        assertThatThrownBy(() -> new AgentCliReceiptIntent(AgentCliAction.INSTALL, release, fx.installed, Instant.EPOCH)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AgentCliReceiptIntent(AgentCliAction.INSTALL, release, fx.installed, Instant.ofEpochMilli(9_007_199_254_740_992L)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AgentCliReceiptIntent(null, release, fx.installed, Instant.ofEpochMilli(1))).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new AgentCliReceiptIntent(AgentCliAction.INSTALL, null, fx.installed, Instant.ofEpochMilli(1))).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new AgentCliReceiptIntent(AgentCliAction.INSTALL, release, null, Instant.ofEpochMilli(1))).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new AgentCliReceiptIntent(AgentCliAction.INSTALL, release, fx.installed, null)).isInstanceOf(NullPointerException.class);
    }
}
