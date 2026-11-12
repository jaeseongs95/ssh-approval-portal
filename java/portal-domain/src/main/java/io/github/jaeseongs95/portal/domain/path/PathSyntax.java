package io.github.jaeseongs95.portal.domain.path;

/**
 * The path syntax a target uses, chosen by the administrator's platform setting for the target. The target's platform answers it and the caller asks the syntax
 * to make the path, so a Windows target's path is always checked as a Windows path and a Linux target's as a POSIX path (stage 2 design 4.3).
 */
public enum PathSyntax {
    POSIX {
        @Override
        public RemotePath path(String text) {
            return new PosixRemotePath(text);
        }
    },
    WINDOWS {
        @Override
        public RemotePath path(String text) {
            return new WindowsRemotePath(text);
        }
    };

    /** The path in this syntax; the text must be valid in it. */
    public abstract RemotePath path(String text);
}
