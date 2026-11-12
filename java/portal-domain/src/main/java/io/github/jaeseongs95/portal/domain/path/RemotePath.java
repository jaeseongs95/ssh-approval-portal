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
     * Picks the syntax from the text itself: a drive letter and a colon means Windows, anything else POSIX (2.x validation.mjs:37-40). It is for the places that
     * do not yet know which target the path is for (a staged file). Where the target is known, {@link PathSyntax#path(String)} chooses the syntax.
     */
    static RemotePath parse(String text) {
        Objects.requireNonNull(text, "text");
        boolean drive = text.length() >= 2 && text.charAt(1) == ':' && (text.charAt(0) >= 'a' && text.charAt(0) <= 'z' || text.charAt(0) >= 'A' && text.charAt(0) <= 'Z');
        return drive ? new WindowsRemotePath(text) : new PosixRemotePath(text);
    }
}
