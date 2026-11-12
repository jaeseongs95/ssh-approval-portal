package io.github.jaeseongs95.portal.domain.redact;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * The redactor of ssh-mcp 2.18.0 ({@code redactText}, guard/redactor.js:32-49, rules RD-01 to RD-12). The seven secret patterns run in a fixed order, each on the
 * result of the one before, then the entropy scan. 2.x always calls the vendor with the entropy scan on and the default threshold 4.5; that is what
 * {@link #VendorOutputRedactor()} does. The other two ways to build it are for the cases that test the rules apart.
 * <p>
 * Differences from JavaScript that the rules take care of: the white space in a pattern is the ECMAScript set ({@code \s} of Java is smaller); letter case is folded
 * for ASCII only; the length in a replacement is the number of UTF-16 code units. One difference is left: the bound {@code {0,65536}} of the private key body counts
 * code points in Java and code units in JavaScript, so a body with characters outside the Basic Multilingual Plane may be longer than 65536 code units and still
 * match. The redactor then replaces more than the vendor does, never less.
 */
public final class VendorOutputRedactor implements OutputRedactor {

    /** The threshold the 2.x call leaves to the vendor default (RD-10). */
    public static final double DEFAULT_ENTROPY_THRESHOLD = 4.5;

    /** The ECMAScript white space as the members of a character class: the same set as {@code \s} and {@code trim} of JavaScript (RK-03). */
    private static final String SPACE_CHARS = "\\t\\n\\x0B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF";

    private static final String PRIVATE_KEY_KIND = "(?:RSA |EC |OPENSSH |DSA )?";

    /**
     * The patterns in the order of the vendor (RD-01 to RD-07 and RD-09). The private key body is bounded and lazy, because an unbounded lazy body rescans to the end
     * of the input for every BEGIN that has no END (vendor comment, guard/redactor.js:10-13).
     */
    private static final List<SecretPattern> SECRET_PATTERNS = List.of(
        new SecretPattern("aws-access-key", Pattern.compile("AKIA[0-9A-Z]{16}")),
        new SecretPattern("github-token", Pattern.compile("gh[pousr]_[A-Za-z0-9]{36,}")),
        new SecretPattern("gitlab-token", Pattern.compile("glpat-[A-Za-z0-9_-]{20}")),
        new SecretPattern("jwt", Pattern.compile("eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")),
        new SecretPattern("pem-private-key",
            Pattern.compile("-----BEGIN " + PRIVATE_KEY_KIND + "PRIVATE KEY-----[\\s\\S]{0,65536}?-----END " + PRIVATE_KEY_KIND + "PRIVATE KEY-----")),
        new SecretPattern("bearer-auth", Pattern.compile("[Bb]earer[" + SPACE_CHARS + "]+[A-Za-z0-9._~+/-]+=*")),
        new SecretPattern("generic-api-key", Pattern.compile("(?:api[_-]?key|api[_-]?secret)[\"'" + SPACE_CHARS + "]*[:=][" + SPACE_CHARS + "]*[\"']([A-Za-z0-9_\\-]{20,})[\"']",
            Pattern.CASE_INSENSITIVE)));

    private final List<RedactionRule> rules;

    /** The 2.x behavior: the secret patterns, then the entropy scan with the threshold 4.5. */
    public VendorOutputRedactor() {
        this(true, DEFAULT_ENTROPY_THRESHOLD);
    }

    private VendorOutputRedactor(boolean entropyScan, double entropyThreshold) {
        List<RedactionRule> steps = new ArrayList<>(SECRET_PATTERNS);
        if (entropyScan) {
            steps.add(new EntropyRule(entropyThreshold));
        }
        this.rules = List.copyOf(steps);
    }

    /** Only the secret patterns, without the entropy scan (the vendor call without {@code entropyScan}). */
    public static VendorOutputRedactor withoutEntropyScan() {
        return new VendorOutputRedactor(false, DEFAULT_ENTROPY_THRESHOLD);
    }

    /** The secret patterns and the entropy scan with a threshold of one's own (the vendor option {@code entropyThreshold}). */
    public static VendorOutputRedactor withEntropyThreshold(double threshold) {
        return new VendorOutputRedactor(true, threshold);
    }

    @Override
    public RedactedText redact(String raw) {
        String result = raw;
        for (RedactionRule rule : rules) {
            result = rule.apply(result);
        }
        return new RedactedText(result);
    }
}
