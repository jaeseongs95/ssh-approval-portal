package io.github.jaeseongs95.portal.ssh.profile;

import java.io.IOException;
import java.nio.file.FileStore;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Set;

import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * {@link FileAccessRule} for a file store with the {@code posix} view. With {@link Protection#NO_OTHER_ACCESS} a file or folder that the group or others can use in any
 * way is refused, as 2.x did with the mask {@code 0o077} (PF-04, vendor config/loader.js:67-74); with {@link Protection#NO_OTHER_WRITE} only write access of the group or
 * of others is refused. A new folder is {@code rwx------} and a new file {@code rw-------}.
 *
 * <p>Based on the Java SE API: {@code PosixFilePermissions}
 * (https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/nio/file/attribute/PosixFilePermissions.html).
 */
@Component
@Order(1)
public final class PosixFileAccessRule implements FileAccessRule {

    private static final String POSIX_VIEW = "posix";
    private static final int GROUP_AND_OTHERS = 0077;
    private static final int GROUP_AND_OTHERS_WRITE = 0022;

    @Override
    public boolean supports(FileStore store) {
        return store.supportsFileAttributeView(POSIX_VIEW);
    }

    @Override
    public AccessVerdict inspect(Path path, Protection protection) throws IOException {
        return judge(path, Files.isDirectory(path), Files.getPosixFilePermissions(path), protection);
    }

    /** The verdict for the permissions of a path: a judgement over values, the part of {@link #inspect} that needs no file system. */
    public AccessVerdict judge(Path path, boolean folder, Set<PosixFilePermission> permissions, Protection protection) {
        int mode = modeOf(permissions);
        int forbidden = switch (protection) {
            case NO_OTHER_ACCESS -> GROUP_AND_OTHERS;
            case NO_OTHER_WRITE -> GROUP_AND_OTHERS_WRITE;
        };
        if ((mode & forbidden) == 0) {
            return new AccessVerdict.Private();
        }
        String kind = folder ? "Config directory " : "Config file ";
        String accessible = switch (protection) {
            case NO_OTHER_ACCESS -> " is group/world accessible";
            case NO_OTHER_WRITE -> " is group/world writable";
        };
        String required = folder ? "0700. Run: chmod 700 " : "0600. Run: chmod 600 ";
        return new AccessVerdict.Refused(kind + path + accessible + " (mode " + Integer.toOctalString(mode) + "). Required: " + required + path);
    }

    @Override
    public void createFolder(Path folder) throws IOException {
        Files.createDirectories(folder, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
    }

    @Override
    public void createFile(Path file) throws IOException {
        if (!Files.exists(file)) {
            Files.createFile(file, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        }
    }

    private int modeOf(Set<PosixFilePermission> permissions) {
        int mode = 0;
        for (PosixFilePermission permission : permissions) {
            mode |= switch (permission) {
                case OWNER_READ -> 0400;
                case OWNER_WRITE -> 0200;
                case OWNER_EXECUTE -> 0100;
                case GROUP_READ -> 0040;
                case GROUP_WRITE -> 0020;
                case GROUP_EXECUTE -> 0010;
                case OTHERS_READ -> 0004;
                case OTHERS_WRITE -> 0002;
                case OTHERS_EXECUTE -> 0001;
            };
        }
        return mode;
    }
}
