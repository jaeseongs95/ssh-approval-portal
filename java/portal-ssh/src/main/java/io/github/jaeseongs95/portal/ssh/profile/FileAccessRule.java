package io.github.jaeseongs95.portal.ssh.profile;

import java.io.IOException;
import java.nio.file.FileStore;
import java.nio.file.Path;

/**
 * The rule that says who may use a file or a folder, on one kind of file store. A file store offers one of two ways to say it, and the rule is chosen by what the store
 * <em>offers</em> ({@link FileStore#supportsFileAttributeView(String)}), never by the name of the operating system: {@link PosixFileAccessRule} for permission bits,
 * {@link AclFileAccessRule} for an access control list (an NTFS volume). The product runs no program to read an ACL ({@code icacls} of 2.x is not used).
 *
 * <p>The product keeps its own copy of this rule next to the one of the store module, because an SSH adapter does not use the store module (module table, rule A-DIR).
 */
public interface FileAccessRule {

    /** True when this rule can inspect and protect a path on the file store. */
    boolean supports(FileStore store);

    /** What the rule finds on the existing file or folder. */
    AccessVerdict inspect(Path path, Protection protection) throws IOException;

    /** Creates the folder, with its missing parents, so that only its owner can use it. A folder that exists is left as it is. */
    void createFolder(Path folder) throws IOException;

    /** Creates an empty file that only its owner can use. A file that exists is left as it is. */
    void createFile(Path file) throws IOException;
}
