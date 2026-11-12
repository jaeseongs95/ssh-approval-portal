package io.github.jaeseongs95.portal.app.remote;

/** How an uploaded file was put in place of the target path (stage 3 design 4.2). */
public enum ReplaceMethod {
    /** The server's {@code posix-rename@openssh.com} extension replaced the file in one atomic step. */
    POSIX_RENAME,
    /** The extension is not offered: the original was renamed to a backup, the new file renamed in, and the backup removed. */
    BACKUP_SWAP,
    /** The file did not exist or must not be replaced: a plain rename that fails when the target exists. */
    NO_CLOBBER_RENAME
}
