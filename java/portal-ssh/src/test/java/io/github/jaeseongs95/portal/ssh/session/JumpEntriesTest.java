package io.github.jaeseongs95.portal.ssh.session;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.app.remote.SecretValue;
import io.github.jaeseongs95.portal.app.remote.SshCredential;
import io.github.jaeseongs95.portal.domain.target.AccessMode;
import io.github.jaeseongs95.portal.domain.target.AuthMethod;
import io.github.jaeseongs95.portal.domain.target.ConnectionProfile;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.Setting;
import io.github.jaeseongs95.portal.domain.target.TtyMode;
import java.io.IOException;
import java.net.URI;
import java.util.List;
import org.apache.sshd.client.config.hosts.HostConfigEntry;
import org.apache.sshd.client.config.hosts.HostConfigEntryResolver;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Case S3-SS-14: the jump hosts reach MINA by alias, never as host names in a URI. A host name with an underscore has no host in a {@link URI}, and an IPv6 literal needs
 * brackets there; neither may break a chain.
 */
class JumpEntriesTest {

    private static Hop hop(String alias, String host, int port, String user) {
        ConnectionProfile profile = new ConnectionProfile(host, port, user, Setting.unset(), Setting.unset(), AuthMethod.PASSWORD, Setting.unset(), Setting.unset(),
            AccessMode.READ_WRITE, TtyMode.NO_TTY);
        return new Hop(new ProfileAlias(alias), profile, new SshCredential.Password(SecretValue.of("secret")));
    }

    @Test
    @DisplayName("S3-SS-14 a jump host name with an underscore, a plain host with a port and an IPv6 literal (also in brackets) are all given to MINA without a URI; the specification is valid URI hosts")
    void unusualHostNamesAreCarriedByAlias() throws IOException {
        JumpEntries entries = new JumpEntries(List.of(hop("a", "bastion_1.example", 2222, "ops_user"), hop("b", "::1", 22, "me"), hop("c", "[fe80::1]", 2200, "x@y"),
            hop("d", "plain.example", 22, "plain")));
        String specification = entries.specification();
        assertThat(specification).isEqualTo("portal-hop-0,portal-hop-1,portal-hop-2,portal-hop-3");
        for (String item : specification.split(",")) {
            assertThat(URI.create("ssh://" + item).getHost()).as("MINA reads every item with URI.create: it has a host").isEqualTo(item);
        }
        HostConfigEntryResolver resolver = entries.resolver();
        HostConfigEntry first = resolver.resolveEffectiveHost("portal-hop-0", -1, null, null, null, null);
        assertThat(first.getHostName()).isEqualTo("bastion_1.example");
        assertThat(first.getPort()).isEqualTo(2222);
        assertThat(first.getUsername()).isEqualTo("ops_user");
        assertThat(resolver.resolveEffectiveHost("portal-hop-1", -1, null, null, null, null).getHostName()).isEqualTo("::1");
        HostConfigEntry bracketed = resolver.resolveEffectiveHost("portal-hop-2", -1, null, null, null, null);
        assertThat(bracketed.getHostName()).as("the brackets are not part of the address").isEqualTo("fe80::1");
        assertThat(bracketed.getUsername()).isEqualTo("x@y");
        assertThat(resolver.resolveEffectiveHost("some-other-host", 22, null, null, null, null)).as("a name that is not one of ours gets no entry").isNull();
    }

    @Test
    @DisplayName("S3-SS-14 without a jump host there is no specification")
    void noJumpHost() {
        assertThat(new JumpEntries(List.of()).specification()).isEmpty();
    }

    @Test
    @DisplayName("S3-SS-14 the hop of a session is found by its connect address, brackets or not")
    void theHopIsFoundByItsAddress() {
        // HopRouting takes the host of a profile as it is written; a bracketed literal is compared without its brackets (the address MINA connects to has none).
        HopRouting routing = new HopRouting(List.of(hop("a", "[::1]", 2200, "me"), hop("t", "target.example", 22, "tgt")));
        assertThat(routing.target().alias()).isEqualTo(new ProfileAlias("t"));
        assertThat(routing.hops()).hasSize(2);
    }
}
