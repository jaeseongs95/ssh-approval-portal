package io.github.jaeseongs95.portal.store.storage;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.FileStore;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.util.Set;

/**
 * The rule that keeps a folder or a file private to its owner on one kind of file store. A file store offers one of two ways to say who may touch a file, and the
 * rule is chosen by what the file store <em>offers</em> ({@link FileStore#supportsFileAttributeView(String)}), never by the name of the operating system
 * (Principles 1.1): {@link PosixPrivateStorage} for a store with the {@code posix} view (permission bits), {@link AclPrivateStorage} for a store with the {@code acl}
 * view (an NTFS volume). A store with neither is refused by {@link PrivateStorages}; an unsupported store is never accepted as "not checked".
 *
 * <p>The three stores that write sensitive bytes (artifacts, command outputs, the audit file) use the same rule through {@link PrivateStorages}; none of them holds a
 * copy of it.
 */
public interface PrivateStorage {

    /** True when this rule can protect and check a path on the file store. */
    boolean supports(FileStore store);

    /** Creates the folder, with its missing parents, so that only its owner can use it. A folder that exists is left as it is (use {@link #requireProtected}). */
    void createFolder(Path folder) throws IOException;

    /**
     * Opens a file like {@link FileChannel#open(Path, Set, java.nio.file.attribute.FileAttribute[])}; a file that this call creates is private to its owner. The
     * caller passes {@code LinkOption.NOFOLLOW_LINKS} among the options when it must not follow a link.
     */
    FileChannel open(Path file, Set<? extends OpenOption> options) throws IOException;

    /**
     * Throws {@link UnsafeStorageException} when somebody besides the owner (and the system itself, where the file store has such a principal) may use the folder or
     * the file; a regular file on a store that counts links must also have a single name.
     */
    void requireProtected(Path path) throws IOException;
}
