package io.github.jaeseongs95.portal.domain.redact;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Replaces a long run of base64-like characters whose Shannon entropy is above a threshold by {@code [REDACTED:entropy:length]} (vendor guard/redactor.js:18-31
 * and 39-46, rules RD-10 and RD-11). A candidate is 20 or more of {@code A-Z a-z 0-9 + / = _ -}; {@code .}, {@code :} and white space end it. The entropy of a text with
 * k different characters is at most log2(k), so a candidate needs 23 different characters to get above 4.5 and a run of 20 to 22 characters is never replaced.
 * A hash in hexadecimal (4.0) and a UUID (at most 4.09) stay.
 */
final class EntropyRule implements RedactionRule {

    private static final Pattern CANDIDATE = Pattern.compile("[A-Za-z0-9+/=_-]{20,}");

    /** A text shorter than this has no entropy for the rule (it is 0). */
    private static final int MIN_LENGTH = 20;

    private final double threshold;

    EntropyRule(double threshold) {
        this.threshold = threshold;
    }

    @Override
    public String apply(String text) {
        Matcher matcher = CANDIDATE.matcher(text);
        StringBuilder result = null;
        int copiedUpTo = 0;
        while (matcher.find()) {
            String candidate = matcher.group();
            if (shannonEntropy(candidate) > threshold) {
                if (result == null) {
                    result = new StringBuilder(text.length());
                }
                result.append(text, copiedUpTo, matcher.start()).append("[REDACTED:entropy:").append(candidate.length()).append(']');
                copiedUpTo = matcher.end();
            }
        }
        if (result == null) {
            return text;
        }
        return result.append(text, copiedUpTo, text.length()).toString();
    }

    /**
     * The Shannon entropy in bits per character: the sum of {@code -p * log2(p)} over the characters in the order of their first appearance, where p is the count
     * divided by the length. 0 for a text shorter than 20. Java has no {@code log2}; {@code ln(p) / ln(2)} can differ from the JavaScript value in the last bit,
     * which matters for no threshold test that is not a tie.
     */
    double shannonEntropy(String text) {
        if (text.length() < MIN_LENGTH) {
            return 0;
        }
        Map<Integer, Integer> frequencies = new LinkedHashMap<>();
        text.codePoints().forEach(codePoint -> frequencies.merge(codePoint, 1, Integer::sum));
        double entropy = 0;
        for (int count : frequencies.values()) {
            double p = (double) count / text.length();
            entropy -= p * (Math.log(p) / Math.log(2));
        }
        return entropy;
    }
}
