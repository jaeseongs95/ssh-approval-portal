package io.github.jaeseongs95.portal.store.storage;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.FileStore;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.List;
import java.util.Set;

import org.springframework.stereotype.Component;

/**
 * Picks the {@link PrivateStorage} rule that the file store of a path supports and applies it; the strategy beans are injected as a {@code List}, so a rule for another
 * kind of file store is a new bean and no change here. The rules are tried in their {@code @Order} (permission bits first). A file store that no rule supports is
 * refused with {@link UnsafeStorageException}: the protection of the bytes is never "not checked".
 *
 * <p>This class also holds what is the same for every rule and for every store that uses it: a link or a file that is not a regular file is unsafe whatever the file store
 * says, and only an existing path is checked.
 */
@Component
public class PrivateStorages {

    private final List<PrivateStorage> rules;

    public PrivateStorages(List<PrivateStorage> rules) {
        this.rules = List.copyOf(rules);
    }

    /** Creates the folder private to its owner; an existing folder is left as it is. */
    public void createFolder(Path folder) throws IOException {
        ruleFor(folder).createFolder(folder);
    }

    /** Opens the file; a file that this call creates is private to its owner. */
    public FileChannel open(Path file, Set<? extends OpenOption> options) throws IOException {
        return ruleFor(file).open(file, options);
    }

    /** The folder must be a real folder (not a link) and private to its owner. */
    public void requireSafeFolder(Path folder) throws IOException {
        BasicFileAttributes attributes = Files.readAttributes(folder, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (attributes.isSymbolicLink() || !attributes.isDirectory()) {
            throw new UnsafeStorageException(folder.toString(), "not a folder");
        }
        ruleFor(folder).requireProtected(folder);
    }

    /** The file must be a regular file (not a link) and private to its owner. */
    public void requireSafeFile(Path file) throws IOException {
        BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (attributes.isSymbolicLink() || !attributes.isRegularFile()) {
            throw new UnsafeStorageException(file.toString(), "not a regular file");
        }
        ruleFor(file).requireProtected(file);
    }

    /** The rule of the file store that holds the path, or of the nearest folder above it that exists. */
    public PrivateStorage ruleFor(Path path) throws IOException {
        FileStore store = Files.getFileStore(nearestExisting(path));
        for (PrivateStorage rule : rules) {
            if (rule.supports(store)) {
                return rule;
            }
        }
        throw new UnsafeStorageException(path.toString(), "the file store " + store + " supports neither permission bits (posix) nor an access control list (acl)");
    }

    private Path nearestExisting(Path path) {
        Path existing = path.toAbsolutePath();
        while (existing.getParent() != null && !Files.exists(existing, LinkOption.NOFOLLOW_LINKS)) {
            existing = existing.getParent();
        }
        return existing;
    }
}
