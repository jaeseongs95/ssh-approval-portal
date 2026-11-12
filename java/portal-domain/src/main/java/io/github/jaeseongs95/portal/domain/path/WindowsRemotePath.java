package io.github.jaeseongs95.portal.domain.path;

import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * An absolute Windows path of a regular file: a drive letter, a colon and a separator ({@code \} or {@code /}), at most 4096 characters, no white space at either
 * end, no hidden character. Every part after the drive is non-empty, is not {@code .} or {@code ..}, has none of {@code < > : " | ? *}, does not end in a space or
 * a dot, and is not a reserved device name such as {@code CON}, {@code NUL} or {@code COM1} (2.x validation.mjs:30-35). {@code C:\} alone is a directory, not a file.
 */
public record WindowsRemotePath(String value) implements RemotePath {

    /** The upper bound of a path in characters. */
    public static final int MAX_LENGTH = 4096;

    private static final Pattern DRIVE = Pattern.compile("[A-Za-z]:[\\\\/].*", Pattern.DOTALL);
    private static final Pattern SEPARATOR = Pattern.compile("[\\\\/]");
    private static final String FORBIDDEN_CHARACTERS = "<>:\"|?*";
    /** DOS device names, with the superscript digits Windows also reserves; a name is reserved with or without an extension. */
    private static final Pattern RESERVED = Pattern.compile("(?:CON|PRN|AUX|NUL|COM[1-9\\u00b9\\u00b2\\u00b3]|LPT[1-9\\u00b9\\u00b2\\u00b3])(?:\\..*|)", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

    public WindowsRemotePath {
        Utf8Text text = new Utf8Text(value);
        if (!DRIVE.matcher(value).matches() || value.length() > MAX_LENGTH || text.hasOuterWhitespace() || text.hasHiddenCharacters()) {
            throw new IllegalArgumentException("Use an absolute Windows regular-file path");
        }
        for (String part : SEPARATOR.split(value.substring(3), -1)) {
            if (part.isEmpty() || ".".equals(part) || "..".equals(part) || hasForbiddenCharacter(part) || part.endsWith(" ") || part.endsWith(".")
                || RESERVED.matcher(part).matches()) {
                throw new IllegalArgumentException("Use a Windows regular-file path without reserved names or unsafe segments");
            }
        }
    }

    @Override
    public String basename() {
        String[] parts = SEPARATOR.split(value, -1);
        return parts[parts.length - 1];
    }

    @Override
    public boolean isWithin(RemotePath root) {
        Objects.requireNonNull(root, "root");
        if (!(root instanceof WindowsRemotePath windowsRoot)) {
            return false;
        }
        String[] own = SEPARATOR.split(value.substring(3), -1);
        String[] prefix = SEPARATOR.split(windowsRoot.value.substring(3), -1);
        if (!value.substring(0, 1).equalsIgnoreCase(windowsRoot.value.substring(0, 1)) || own.length < prefix.length) {
            return false;
        }
        for (int index = 0; index < prefix.length; index++) {
            if (!own[index].equalsIgnoreCase(prefix[index])) {
                return false;
            }
        }
        return true;
    }

    @Override
    public String directory() {
        int separator = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
        return separator == 2 ? value.substring(0, 3) : value.substring(0, separator);
    }

    @Override
    public RemotePath sibling(String name) {
        Objects.requireNonNull(name, "name");
        String directory = directory();
        boolean atTheRoot = directory.length() == 3;
        // A path below the root has a separator after its directory (the one the path itself uses); the root text already ends in one.
        return new WindowsRemotePath(atTheRoot ? directory + name : directory + value.charAt(directory.length()) + name);
    }

    private static boolean hasForbiddenCharacter(String part) {
        for (int i = 0; i < part.length(); i++) {
            if (FORBIDDEN_CHARACTERS.indexOf(part.charAt(i)) >= 0) {
                return true;
            }
        }
        return false;
    }
}
