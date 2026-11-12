package io.github.jaeseongs95.portal.ssh.session;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.apache.sshd.client.config.hosts.HostConfigEntry;
import org.apache.sshd.client.config.hosts.HostConfigEntryResolver;

/**
 * The jump hosts of a connection in the form MINA's chain takes them, without ever reading a host name as a {@link java.net.URI}.
 *
 * <p>MINA's {@code HostConfigEntry.setProxyJump} takes {@code [user@]host[:port],...} and parses every item with {@code URI.create("ssh://" + item)} ({@code SshClient.parseProxyJumps}).
 * A {@code URI} has no host for a name with an underscore ({@code bastion_1}) and needs brackets for an IPv6 literal, so a host name in the specification is not safe. The
 * specification therefore names each hop by a fixed alias ({@code portal-hop-0}, {@code portal-hop-1} ...), which is always a valid host name, and the real host, port and user
 * come from the {@link HostConfigEntryResolver} of this object, which MINA asks for every item of the list. A host written with brackets in the profile ({@code [::1]}) is
 * given to MINA without them.
 */
final class JumpEntries {

    private static final String ALIAS_PREFIX = "portal-hop-";

    private final Map<String, HostConfigEntry> entries = new LinkedHashMap<>();

    /** The entries of the jump hops, in the order they are connected (the target is not among them). */
    JumpEntries(List<Hop> jumps) {
        int index = 0;
        for (Hop jump : jumps) {
            String alias = ALIAS_PREFIX + index;
            index++;
            entries.put(alias, new HostConfigEntry(alias, bare(jump.profile().host()), jump.profile().port(), jump.profile().user()));
        }
    }

    /** The value for {@code HostConfigEntry.setProxyJump}: the aliases, comma separated, in order; empty when there is no jump host. */
    String specification() {
        return String.join(",", entries.keySet());
    }

    /** What MINA asks to turn an alias of {@link #specification()} into the real host, port and user; any other name is not ours and gets no entry. */
    HostConfigEntryResolver resolver() {
        return (host, port, localAddress, username, proxyJump, context) -> entries.get(host);
    }

    private String bare(String host) {
        return host.length() > 2 && host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
    }
}
