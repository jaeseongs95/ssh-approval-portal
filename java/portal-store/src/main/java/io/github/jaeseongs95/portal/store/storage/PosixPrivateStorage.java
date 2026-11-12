package io.github.jaeseongs95.portal.store.storage;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.FileStore;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Collections;
import java.util.Objects;
import java.util.Set;

import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * {@link PrivateStorage} for a file store with the {@code posix} view: a folder is {@code rwx------}, a file {@code rw-------}, and a path that the group or others may
 * use is refused (2.x {@code privateDirectory}/{@code privateFile}, {@code artifacts.mjs:11-14}). A regular file must have the same owner as its folder, and where the
 * file store also has the {@code unix} view (it reports link counts) it must have one name: a second name could have been made by someone who may write elsewhere, and
 * the bytes behind it would be reachable under it.
 *
 * <p>Based on the Java SE API: {@code java.nio.file.attribute.PosixFileAttributeView} and {@code PosixFilePermissions}
 * (https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/nio/file/attribute/PosixFileAttributeView.html).
 */
@Component
@Order(1)
public final class PosixPrivateStorage implements PrivateStorage {

    private static final Set<PosixFilePermission> GROUP_AND_OTHERS = Set.of(PosixFilePermission.GROUP_READ, PosixFilePermission.GROUP_WRITE, PosixFilePermission.GROUP_EXECUTE,
        PosixFilePermission.OTHERS_READ, PosixFilePermission.OTHERS_WRITE, PosixFilePermission.OTHERS_EXECUTE);
    private static final String POSIX_VIEW = "posix";
    private static final String UNIX_VIEW = "unix";
    private static final String LINK_COUNT = "unix:nlink";

    @Override
    public boolean supports(FileStore store) {
        return store.supportsFileAttributeView(POSIX_VIEW);
    }

    @Override
    public void createFolder(Path folder) throws IOException {
        Files.createDirectories(folder, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
    }

    @Override
    public FileChannel open(Path file, Set<? extends OpenOption> options) throws IOException {
        return FileChannel.open(file, options, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
    }

    @Override
    public void requireProtected(Path path) throws IOException {
        Set<PosixFilePermission> permissions = Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS);
        if (!Collections.disjoint(permissions, GROUP_AND_OTHERS)) {
            throw new UnsafeStorageException(path.toString(), "the group or others have access");
        }
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        Path folder = path.toAbsolutePath().getParent();
        if (folder != null && !Objects.equals(Files.getOwner(path, LinkOption.NOFOLLOW_LINKS), Files.getOwner(folder))) {
            throw new UnsafeStorageException(path.toString(), "another owner than its folder");
        }
        if (Files.getFileStore(path).supportsFileAttributeView(UNIX_VIEW) && !Integer.valueOf(1).equals(Files.getAttribute(path, LINK_COUNT, LinkOption.NOFOLLOW_LINKS))) {
            throw new UnsafeStorageException(path.toString(), "more than one hard link");
        }
    }
}
