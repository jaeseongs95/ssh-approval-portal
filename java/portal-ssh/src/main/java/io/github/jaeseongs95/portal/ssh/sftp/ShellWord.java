package io.github.jaeseongs95.portal.ssh.sftp;

import java.util.Objects;

/**
 * One word of a POSIX shell command line, written so that the shell reads it as exactly that text: in single quotes, with every single quote in it closed, escaped and
 * opened again. Inside single quotes a POSIX shell expands nothing, so a path or a digest that is put into a fixed command through this type can never become code.
 * The text may not hold a NUL character (a command line cannot carry one).
 *
 * @param text the word as the program will receive it
 */
public record ShellWord(String text) {

    public ShellWord {
        Objects.requireNonNull(text, "text");
        if (text.indexOf('\0') >= 0) {
            throw new IllegalArgumentException("A shell word has no NUL");
        }
    }

    /** The word in single quotes, ready to be appended to a command line. */
    public String quoted() {
        return "'" + text.replace("'", "'\\''") + "'";
    }
}
