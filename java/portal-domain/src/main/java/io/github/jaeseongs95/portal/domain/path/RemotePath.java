package io.github.jaeseongs95.portal.domain.path;

import java.util.Objects;

/**
 * The absolute path of a regular file on a target. It is not a {@link java.nio.file.Path}: the path belongs to the machine at the other end, and a server on one
 * operating system has to handle the path syntax of a target on another (a Linux server and a Windows target's {@code C:\x}). The JDK documents that a
 * {@code Path} represents "a system dependent file path", so it knows only the syntax of the system the server runs on. The syntax is part of the value:
 * {@link PosixRemotePath} or {@link WindowsRemotePath}. The path of a file on the server itself is a {@code Path} and never one of these.
 */
public sealed interface RemotePath permits PosixRemotePath, WindowsRemotePath {

    /** The path text exactly as accepted. */
    String value();

    /** The last name of the path; trailing separators are not part of it. */
    String basename();

    /**
     * Whether this path is the root itself or lies below it, compared part by part in this path's own syntax: a POSIX path compares its parts exactly, a Windows path
     * ignores the case of the drive letter and of every part and takes {@code \} and {@code /} as the same separator. A root of the other syntax contains nothing,
     * and a part that only starts with the root's last part ({@code /data} and {@code /database/x}) is not inside it. This is a comparison of the written paths: it
     * does not resolve links, which the adapter that touches the file does.
     */
    boolean isWithin(RemotePath root);

    /**
     * The directory that holds the file, as text: everything before the last part without the separator in front of it, or the root ({@code /} or {@code C:\})
     * for a file at the top. The result is a directory, so it is not a {@code RemotePath} (a path of this type is a regular file).
     */
    String directory();

    /**
     * A file of the given name in the same directory, in the same syntax (the path of a temporary or backup file next to this one). The name must be a valid part of
     * a path of this syntax; otherwise the constructor of the path type refuses it.
     */
    RemotePath sibling(String name);

    /**
     * Picks the syntax from the text itself: a drive letter and a colon means Windows, anything else POSIX (2.x validation.mjs:37-40). It is for the places that
     * do not yet know which target the path is for (a staged file). Where the target is known, {@link PathSyntax#path(String)} chooses the syntax.
     */
    static RemotePath parse(String text) {
        Objects.requireNonNull(text, "text");
        boolean drive = text.length() >= 2 && text.charAt(1) == ':' && (text.charAt(0) >= 'a' && text.charAt(0) <= 'z' || text.charAt(0) >= 'A' && text.charAt(0) <= 'Z');
        return drive ? new WindowsRemotePath(text) : new PosixRemotePath(text);
    }
}
