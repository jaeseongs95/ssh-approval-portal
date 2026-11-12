package io.github.jaeseongs95.portal.domain.path;

import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.util.Objects;

/**
 * An absolute POSIX path of a regular file: it starts with a slash, is not the root alone, has at most 4096 characters, has no white space at either end and no
 * hidden character, and none of its parts is {@code .} or {@code ..}. Empty parts ({@code //}) are accepted; a backslash is an ordinary character (2.x
 * validation.mjs:25-28). White space is the JavaScript notion, which also covers the no-break space.
 */
public record PosixRemotePath(String value) implements RemotePath {

    /** The upper bound of a path in characters. */
    public static final int MAX_LENGTH = 4096;

    public PosixRemotePath {
        Utf8Text text = new Utf8Text(value);
        if (!value.startsWith("/") || "/".equals(value) || value.length() > MAX_LENGTH || text.hasOuterWhitespace() || text.hasHiddenCharacters()) {
            throw new IllegalArgumentException("Use an absolute regular-file path without dot segments or hidden characters");
        }
        for (String part : value.split("/", -1)) {
            if (".".equals(part) || "..".equals(part)) {
                throw new IllegalArgumentException("Use an absolute regular-file path without dot segments or hidden characters");
            }
        }
    }

    @Override
    public String basename() {
        int end = value.length();
        while (end > 0 && value.charAt(end - 1) == '/') {
            end--;
        }
        return value.substring(value.lastIndexOf('/', end - 1) + 1, end);
    }
}
