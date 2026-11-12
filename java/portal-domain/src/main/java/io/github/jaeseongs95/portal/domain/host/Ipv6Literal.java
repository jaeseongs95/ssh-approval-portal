package io.github.jaeseongs95.portal.domain.host;

import java.util.Objects;
import java.util.regex.Pattern;

/**
 * The text between the brackets of an IPv6 address in a URL. It is canonical when the URL Standard's IPv6 serializer (https://url.spec.whatwg.org/#concept-ipv6-serializer)
 * writes the same text back: lowercase hex without leading zeros, and the first longest run of two or more zero pieces written as {@code ::}. Another spelling
 * of the same address ({@code 0:0:0:0:0:0:0:1}) is not canonical. An address with an embedded IPv4 part is not canonical either, because the serializer writes
 * every piece as hex.
 */
public record Ipv6Literal(String text) {

    private static final int PIECES = 8;
    private static final Pattern PIECE = Pattern.compile("[0-9a-f]{1,4}");

    public Ipv6Literal {
        Objects.requireNonNull(text, "text");
    }

    public boolean isCanonical() {
        int compress = text.indexOf("::");
        if (compress >= 0 && text.indexOf("::", compress + 1) >= 0) {
            return false;
        }
        String head = compress >= 0 ? text.substring(0, compress) : text;
        String tail = compress >= 0 ? text.substring(compress + 2) : "";
        if (!isRun(head) || !isRun(tail)) {
            return false;
        }
        int[] first = values(head);
        int[] last = values(tail);
        int[] pieces = new int[PIECES];
        if (compress < 0) {
            if (first.length != PIECES) {
                return false;
            }
            pieces = first;
        } else {
            if (first.length + last.length >= PIECES) {
                return false;
            }
            System.arraycopy(first, 0, pieces, 0, first.length);
            System.arraycopy(last, 0, pieces, PIECES - last.length, last.length);
        }
        return serialize(pieces).equals(text);
    }

    /** True for an empty run or colon separated pieces of one to four lowercase hex digits. */
    private static boolean isRun(String run) {
        if (run.isEmpty()) {
            return true;
        }
        for (String part : run.split(":", -1)) {
            if (!PIECE.matcher(part).matches()) {
                return false;
            }
        }
        return true;
    }

    private static int[] values(String run) {
        if (run.isEmpty()) {
            return new int[0];
        }
        String[] parts = run.split(":", -1);
        int[] values = new int[parts.length];
        for (int i = 0; i < parts.length; i++) {
            values[i] = Integer.parseInt(parts[i], 16);
        }
        return values;
    }

    private static String serialize(int[] pieces) {
        int compressStart = -1;
        int compressLength = 1;
        for (int i = 0; i < pieces.length; i++) {
            if (pieces[i] != 0) {
                continue;
            }
            int end = i;
            while (end < pieces.length && pieces[end] == 0) {
                end++;
            }
            if (end - i > compressLength) {
                compressStart = i;
                compressLength = end - i;
            }
            i = end;
        }
        StringBuilder out = new StringBuilder();
        boolean ignoreZero = false;
        for (int i = 0; i < pieces.length; i++) {
            if (ignoreZero && pieces[i] == 0) {
                continue;
            }
            ignoreZero = false;
            if (i == compressStart) {
                out.append(i == 0 ? "::" : ":");
                ignoreZero = true;
                continue;
            }
            out.append(Integer.toHexString(pieces[i]));
            if (i != pieces.length - 1) {
                out.append(':');
            }
        }
        return out.toString();
    }
}
