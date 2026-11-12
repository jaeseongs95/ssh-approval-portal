package io.github.jaeseongs95.portal.domain.host;

import java.util.Objects;

/**
 * One source an upload may be fetched from: an exact DNS host name, or a leading {@code *.domain} that matches every host below the domain. Nothing else is a
 * pattern: no URL, no port, no user, no IP address in any spelling, no wildcard in the middle (2.x upload-hosts.mjs:6-17). The text is lowercase.
 */
public sealed interface UploadHostPattern permits UploadHostPattern.ExactHost, UploadHostPattern.WildcardSuffix {

    /** The pattern as an administrator writes it: {@code files.example.test} or {@code *.example.test}. */
    String text();

    /** True when the host name (lowercase) is covered by the pattern. */
    boolean matches(String host);

    /** Reads one pattern as written. */
    static UploadHostPattern parse(String text) {
        Objects.requireNonNull(text, "text");
        return text.startsWith("*.") ? new WildcardSuffix(text.substring(2)) : new ExactHost(text);
    }

    /** A pattern naming exactly one host. */
    record ExactHost(String host) implements UploadHostPattern {

        public ExactHost {
            requireValidHost(host, false);
        }

        @Override
        public String text() {
            return host;
        }

        @Override
        public boolean matches(String candidate) {
            return host.equals(candidate);
        }
    }

    /** A pattern naming every host below a domain: {@code *.example.test} matches {@code files.example.test} and {@code a.b.example.test}, not {@code example.test}. */
    record WildcardSuffix(String domain) implements UploadHostPattern {

        public WildcardSuffix {
            requireValidHost(domain, true);
        }

        @Override
        public String text() {
            return "*." + domain;
        }

        @Override
        public boolean matches(String candidate) {
            String suffix = "." + domain;
            return candidate.endsWith(suffix) && candidate.length() > suffix.length();
        }
    }

    private static void requireValidHost(String host, boolean wildcard) {
        Objects.requireNonNull(host, "host");
        HostName name = new HostName(host);
        // The URL parser reads a name whose last label is a number as an IPv4 address, so every spelling of an address (127.0.0.1, 127.1, 0x7f000001, files.123) is refused.
        if (!name.hasDnsLabels() || wildcard && host.indexOf('.') < 0 || name.endsInNumber() || !name.hasCanonicalAceLabels()) {
            throw new IllegalArgumentException("Configure exact DNS hostnames or leading *.domain suffixes");
        }
    }
}
