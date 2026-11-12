package io.github.jaeseongs95.portal.domain.classify;

import java.io.ByteArrayOutputStream;
import java.util.Optional;

/**
 * Reads the program a PowerShell {@code -EncodedCommand} operand carries: base64 of the UTF-16LE text (vendor {@code decodedPowerShellCommand},
 * policy/classifier.js:1808-1831, rule CL-I07). The decoding is Node's {@code Buffer.from(text, 'base64').toString('utf16le')} and never stricter, because a payload
 * that fails to decode would skip the classification of the program inside it (risk RK-07):
 * <ul>
 * <li>both the standard alphabet ({@code + /}) and the URL-safe one ({@code - _}) are read, a character outside them is skipped, the first {@code =} ends the
 * input, a missing padding is no error, and bits that do not fill a byte are dropped;</li>
 * <li>two bytes make one char as they are, a lone surrogate included; a last odd byte is dropped; there is no replacement character and no exception.</li>
 * </ul>
 * Two differences from the vendor, both on the side of more classification: a text that is only white space has no program and gives nothing (as in the vendor),
 * but a text that has U+FFFD in it is still returned. The vendor throws such a text away, so a program hidden behind a U+FFFD char was never classified.
 */
final class EncodedCommandDecoder {

    /** The operand is read up to this many characters (a multiple of four, so the cut does not split a base64 group). */
    private static final int MAX_ENCODED_CHARS = 64 * 1024;

    private final ShellText text;

    EncodedCommandDecoder(ShellText text) {
        this.text = text;
    }

    /** The decoded program, or empty when the operand decodes to nothing but white space. */
    Optional<String> decode(String operand) {
        String prefix = operand.length() > MAX_ENCODED_CHARS ? operand.substring(0, MAX_ENCODED_CHARS - MAX_ENCODED_CHARS % 4) : operand;
        byte[] bytes = base64Bytes(prefix);
        char[] chars = new char[bytes.length / 2];
        for (int i = 0; i < chars.length; i++) {
            chars[i] = (char) (bytes[2 * i] & 0xFF | (bytes[2 * i + 1] & 0xFF) << 8);
        }
        String decoded = String.valueOf(chars);
        return text.trim(decoded).isEmpty() ? Optional.empty() : Optional.of(decoded);
    }

    private byte[] base64Bytes(String input) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(input.length() * 3 / 4 + 3);
        int accumulator = 0;
        int bits = 0;
        for (int i = 0; i < input.length(); i++) {
            char c = input.charAt(i);
            if (c == '=') {
                break;
            }
            int sextet = sextetOf(c);
            if (sextet < 0) {
                continue;
            }
            accumulator = accumulator << 6 | sextet;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                bytes.write(accumulator >> bits & 0xFF);
                accumulator &= (1 << bits) - 1;
            }
        }
        return bytes.toByteArray();
    }

    private int sextetOf(char c) {
        if (c >= 'A' && c <= 'Z') {
            return c - 'A';
        }
        if (c >= 'a' && c <= 'z') {
            return c - 'a' + 26;
        }
        if (c >= '0' && c <= '9') {
            return c - '0' + 52;
        }
        if (c == '+' || c == '-') {
            return 62;
        }
        if (c == '/' || c == '_') {
            return 63;
        }
        return -1;
    }
}
