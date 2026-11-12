package io.github.jaeseongs95.portal.domain.host;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;

/**
 * The part after {@code xn--} of an internationalized host name label (an "A-label"), written in Punycode (RFC 3492). It answers one question: is this a
 * canonical A-label, one that decodes to a real non-ASCII name and encodes back to exactly the same text. The JDK's {@link java.net.IDN} is IDNA2003 and rejects
 * labels the URL Standard accepts (the German sharp s and the final sigma), so the codec is written here; a label the codec cannot decode, or that decodes to
 * something that is not lowercase, composed text of letters, marks and digits, is rejected. Stricter than the URL Standard, never looser.
 */
record AceLabel(String body) {

    private static final int BASE = 36;
    private static final int T_MIN = 1;
    private static final int T_MAX = 26;
    private static final int SKEW = 38;
    private static final int DAMP = 700;
    private static final int INITIAL_BIAS = 72;
    private static final int INITIAL_N = 128;
    private static final int MAX_CODE_POINT = 0x10FFFF;
    private static final char DELIMITER = '-';

    AceLabel {
        Objects.requireNonNull(body, "body");
    }

    /** True when the label decodes to a valid non-ASCII name and that name encodes back to this label. */
    boolean isCanonical() {
        return decode().map(unicode -> isIdnText(unicode) && isEncodingOf(unicode)).orElse(false);
    }

    /** The decoded text (RFC 3492 section 6.2), or nothing when the label is malformed or the result is out of range. */
    Optional<String> decode() {
        List<Integer> output = new ArrayList<>();
        int basicEnd = Math.max(0, body.lastIndexOf(DELIMITER));
        for (int j = 0; j < basicEnd; j++) {
            char c = body.charAt(j);
            if (c >= INITIAL_N) {
                return Optional.empty();
            }
            output.add((int) c);
        }
        long n = INITIAL_N;
        long i = 0;
        int bias = INITIAL_BIAS;
        int index = basicEnd > 0 ? basicEnd + 1 : 0;
        while (index < body.length()) {
            long previous = i;
            long weight = 1;
            for (int k = BASE; ; k += BASE) {
                if (index >= body.length()) {
                    return Optional.empty();
                }
                int digit = digitValue(body.charAt(index++));
                if (digit >= BASE || digit > (Integer.MAX_VALUE - i) / weight) {
                    return Optional.empty();
                }
                i += digit * weight;
                int threshold = threshold(k, bias);
                if (digit < threshold) {
                    break;
                }
                if (weight > Integer.MAX_VALUE / (BASE - threshold)) {
                    return Optional.empty();
                }
                weight *= BASE - threshold;
            }
            int count = output.size() + 1;
            bias = adapt(i - previous, count, previous == 0);
            if (i / count > MAX_CODE_POINT - n) {
                return Optional.empty();
            }
            n += i / count;
            i %= count;
            if (n > MAX_CODE_POINT || n >= Character.MIN_SURROGATE && n <= Character.MAX_SURROGATE) {
                return Optional.empty();
            }
            output.add((int) i, (int) n);
            i++;
        }
        StringBuilder text = new StringBuilder();
        output.forEach(text::appendCodePoint);
        return Optional.of(text.toString());
    }

    /** True when the Punycode encoding of the text (RFC 3492 section 6.3) is exactly this label. */
    boolean isEncodingOf(String unicode) {
        int[] input = unicode.codePoints().toArray();
        StringBuilder out = new StringBuilder();
        long basic = 0;
        for (int codePoint : input) {
            if (codePoint < INITIAL_N) {
                out.append((char) codePoint);
                basic++;
            }
        }
        long handled = basic;
        if (basic > 0) {
            out.append(DELIMITER);
        }
        long n = INITIAL_N;
        long delta = 0;
        int bias = INITIAL_BIAS;
        while (handled < input.length) {
            long next = Long.MAX_VALUE;
            for (int codePoint : input) {
                if (codePoint >= n && codePoint < next) {
                    next = codePoint;
                }
            }
            delta += (next - n) * (handled + 1);
            n = next;
            for (int codePoint : input) {
                if (codePoint < n) {
                    delta++;
                }
                if (codePoint == n) {
                    long q = delta;
                    for (int k = BASE; ; k += BASE) {
                        int threshold = threshold(k, bias);
                        if (q < threshold) {
                            break;
                        }
                        out.append(digitChar((int) (threshold + (q - threshold) % (BASE - threshold))));
                        q = (q - threshold) / (BASE - threshold);
                    }
                    out.append(digitChar((int) q));
                    bias = adapt(delta, (int) (handled + 1), handled == basic);
                    delta = 0;
                    handled++;
                }
            }
            delta++;
            n++;
        }
        return out.toString().equals(body);
    }

    /** Lowercase, composed text; every non-ASCII character a letter, a combining mark or a digit; at least one non-ASCII character; ASCII only {@code a-z 0-9 -}. */
    private static boolean isIdnText(String text) {
        if (!Normalizer.isNormalized(text, Normalizer.Form.NFC) || !text.equals(text.toLowerCase(Locale.ROOT))) {
            return false;
        }
        boolean nonAscii = false;
        for (int codePoint : text.codePoints().toArray()) {
            if (codePoint < INITIAL_N) {
                boolean allowed = codePoint >= 'a' && codePoint <= 'z' || codePoint >= '0' && codePoint <= '9' || codePoint == '-';
                if (!allowed) {
                    return false;
                }
            } else {
                nonAscii = true;
                int type = Character.getType(codePoint);
                boolean allowed = Character.isLetter(codePoint) || Character.isDigit(codePoint)
                    || type == Character.NON_SPACING_MARK || type == Character.COMBINING_SPACING_MARK;
                if (!allowed) {
                    return false;
                }
            }
        }
        return nonAscii;
    }

    private static int threshold(int k, int bias) {
        if (k <= bias) {
            return T_MIN;
        }
        return k >= bias + T_MAX ? T_MAX : k - bias;
    }

    private static int adapt(long delta, int pointCount, boolean firstTime) {
        long scaled = firstTime ? delta / DAMP : delta / 2;
        scaled += scaled / pointCount;
        int k = 0;
        while (scaled > ((BASE - T_MIN) * T_MAX) / 2) {
            scaled /= BASE - T_MIN;
            k += BASE;
        }
        return (int) (k + ((BASE - T_MIN + 1) * scaled) / (scaled + SKEW));
    }

    private static int digitValue(char c) {
        if (c >= 'a' && c <= 'z') {
            return c - 'a';
        }
        if (c >= 'A' && c <= 'Z') {
            return c - 'A';
        }
        if (c >= '0' && c <= '9') {
            return c - '0' + 26;
        }
        return BASE;
    }

    private static char digitChar(int digit) {
        return (char) (digit < 26 ? 'a' + digit : '0' + digit - 26);
    }
}
