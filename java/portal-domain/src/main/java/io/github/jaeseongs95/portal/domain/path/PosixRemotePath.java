package io.github.jaeseongs95.portal.domain.path;

import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.util.ArrayList;
import java.util.List;
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

    @Override
    public boolean isWithin(RemotePath root) {
        Objects.requireNonNull(root, "root");
        if (!(root instanceof PosixRemotePath posixRoot)) {
            return false;
        }
        List<String> own = parts(value);
        List<String> prefix = parts(posixRoot.value);
        return own.size() >= prefix.size() && own.subList(0, prefix.size()).equals(prefix);
    }

    @Override
    public String directory() {
        int end = value.length();
        while (end > 0 && value.charAt(end - 1) == '/') {
            end--;
        }
        int slash = value.lastIndexOf('/', end - 1);
        int directoryEnd = slash;
        while (directoryEnd > 0 && value.charAt(directoryEnd - 1) == '/') {
            directoryEnd--;
        }
        return directoryEnd <= 0 ? "/" : value.substring(0, directoryEnd);
    }

    @Override
    public RemotePath sibling(String name) {
        Objects.requireNonNull(name, "name");
        String directory = directory();
        return new PosixRemotePath("/".equals(directory) ? "/" + name : directory + "/" + name);
    }

    /** The non-empty parts of a path; empty parts ({@code //}) name the same directory. */
    private static List<String> parts(String path) {
        List<String> parts = new ArrayList<>();
        for (String part : path.split("/", -1)) {
            if (!part.isEmpty()) {
                parts.add(part);
            }
        }
        return parts;
    }
}
