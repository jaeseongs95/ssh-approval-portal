package io.github.jaeseongs95.portal.domain.host;

import java.util.Objects;
import java.util.regex.Pattern;

/**
 * A host name that is not an IPv6 address. It applies the rules the URL Standard (https://url.spec.whatwg.org/#host-parsing) adds to a name written with the
 * characters {@code a-z 0-9 . - _}, which a pattern alone cannot: a name whose last label is a number is an IPv4 address and must be written in the one
 * canonical dotted form ({@code 127.1}, {@code 2130706433} and {@code 0x7f000001} are other spellings of an address and are refused), and an {@code xn--} label
 * must be a canonical Punycode label. 2.x let the WHATWG URL parser of Node decide this; Java has no such parser.
 */
public record HostName(String text) {

    private static final Pattern DECIMAL = Pattern.compile("[0-9]+");
    private static final Pattern HEX_NUMBER = Pattern.compile("0[xX][0-9a-fA-F]*");
    private static final Pattern IPV4_PART = Pattern.compile("0|[1-9][0-9]{0,2}");
    private static final Pattern DNS_LABEL = Pattern.compile("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?");
    private static final int MAX_LENGTH = 253;
    private static final int IPV4_PARTS = 4;
    private static final int OCTET_MAX = 255;
    private static final String ACE_PREFIX = "xn--";

    public HostName {
        Objects.requireNonNull(text, "text");
    }

    /**
     * True when the name is DNS shaped: 1 to 253 characters in dot separated labels, each label 1 to 63 characters of {@code a-z 0-9 -} that neither starts nor ends
     * with a hyphen. A trailing dot, an empty label and an underscore are refused.
     */
    public boolean hasDnsLabels() {
        if (text.isEmpty() || text.length() > MAX_LENGTH) {
            return false;
        }
        for (String label : text.split("\\.", -1)) {
            if (!DNS_LABEL.matcher(label).matches()) {
                return false;
            }
        }
        return true;
    }

    /** The URL Standard's "ends in a number" test: the last label, ignoring one trailing dot, is decimal digits or {@code 0x} with hex digits. */
    public boolean endsInNumber() {
        String[] labels = text.split("\\.", -1);
        int count = labels.length;
        if (labels[count - 1].isEmpty()) {
            if (count == 1) {
                return false;
            }
            count--;
        }
        String last = labels[count - 1];
        return DECIMAL.matcher(last).matches() || HEX_NUMBER.matcher(last).matches();
    }

    /** True when the text is four decimal parts of 0 to 255 without leading zeros: the only spelling of an IPv4 address that parses back to itself. */
    public boolean isCanonicalIpv4() {
        String[] parts = text.split("\\.", -1);
        if (parts.length != IPV4_PARTS) {
            return false;
        }
        for (String part : parts) {
            if (!IPV4_PART.matcher(part).matches() || Integer.parseInt(part) > OCTET_MAX) {
                return false;
            }
        }
        return true;
    }

    /** True when every {@code xn--} label is a canonical Punycode label. */
    public boolean hasCanonicalAceLabels() {
        for (String label : text.split("\\.", -1)) {
            if (label.startsWith(ACE_PREFIX) && !new AceLabel(label.substring(ACE_PREFIX.length())).isCanonical()) {
                return false;
            }
        }
        return true;
    }

    /** True when the name survives URL host parsing unchanged: canonical Punycode labels, and a numeric last label only as a canonical IPv4 address. */
    public boolean isCanonicalUrlHost() {
        return hasCanonicalAceLabels() && (!endsInNumber() || isCanonicalIpv4());
    }
}
