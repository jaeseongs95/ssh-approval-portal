package io.github.jaeseongs95.portal.domain.origin;

import io.github.jaeseongs95.portal.domain.host.HostName;
import io.github.jaeseongs95.portal.domain.host.Ipv6Literal;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * The one canonical HTTPS origin the administrator console is reached at: {@code https://host} or {@code https://host:port}, lowercase, without path, query,
 * fragment or user information, and in the form a URL parser writes back unchanged. That last condition is what 2.x got from {@code new URL(value).origin === value}:
 * the default port {@code :443}, another spelling of an IPv4 address ({@code 127.1}), a non-canonical IPv6 address and a Punycode label that is not canonical are
 * all refused. The shared vectors in {@code contract/settings/settings-contract.json} decide the cases (2.x settings.mjs:13-28).
 */
public record AdminOrigin(String value) {

    /** The upper bound of the text (2.x settings-contract.json originMaxBytes). */
    public static final int MAX_LENGTH = 4096;

    private static final String SCHEME = "https://";
    private static final int DEFAULT_PORT = 443;
    private static final int MAX_PORT = 65535;
    private static final Pattern SHAPE = Pattern.compile("https://(?:\\[[0-9a-f:]+\\]|[a-z0-9._-]+)(?::[1-9][0-9]{0,4})?");

    public AdminOrigin {
        Objects.requireNonNull(value, "value");
        if (value.length() > MAX_LENGTH || !SHAPE.matcher(value).matches() || !hostAndPortAreCanonical(value.substring(SCHEME.length()))) {
            throw new IllegalArgumentException("Configure one canonical HTTPS administrator origin");
        }
    }

    private static boolean hostAndPortAreCanonical(String authority) {
        boolean bracketed = authority.startsWith("[");
        int hostEnd = bracketed ? authority.indexOf(']') : authority.indexOf(':');
        if (hostEnd < 0) {
            hostEnd = authority.length();
        }
        String host = bracketed ? authority.substring(1, hostEnd) : authority.substring(0, hostEnd);
        String rest = authority.substring(bracketed ? hostEnd + 1 : hostEnd);
        if (!rest.isEmpty()) {
            int port = Integer.parseInt(rest.substring(1));
            if (port > MAX_PORT || port == DEFAULT_PORT) {
                return false;
            }
        }
        return bracketed ? new Ipv6Literal(host).isCanonical() : new HostName(host).isCanonicalUrlHost();
    }
}
