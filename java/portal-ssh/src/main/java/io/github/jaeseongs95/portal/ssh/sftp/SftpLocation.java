package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import io.github.jaeseongs95.portal.domain.path.WindowsRemotePath;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/**
 * Where a file is in the form an SFTP server takes: the path of a request ({@link RemotePath}, in the target's own syntax) written as SFTP paths. SFTP paths use
 * {@code /} and are absolute; a POSIX path is sent as it is, a Windows path as {@code /C:/dir/file}, the form the Win32-OpenSSH {@code sftp-server} documents
 * (the real servers' answer to that is checked by the Windows tests, S3-RW-02). The class only builds names; what lies behind them is asked of the server.
 *
 * @param path the path of the request
 */
public record SftpLocation(RemotePath path) {

    public SftpLocation {
        Objects.requireNonNull(path, "path");
    }

    /** The file itself. */
    public String file() {
        return sftp(path.value());
    }

    /** The directory that holds the file. */
    public String directory() {
        return sftp(path.directory());
    }

    /** A file of the same directory, such as the temporary or the backup file of a replacement. */
    public String sibling(String name) {
        return sftp(path.sibling(name).value());
    }

    /**
     * The directories on the way to the file, from the one below the root down to the one that holds it, as SFTP paths. A Windows drive is the root and is not listed.
     * The adapter asks the server about each of them, because a link in any of them leads somewhere the request did not name.
     */
    public List<String> ancestors() {
        List<String> parts = new ArrayList<>();
        for (String part : directory().split("/", -1)) {
            if (!part.isEmpty()) {
                parts.add(part);
            }
        }
        int first = path instanceof WindowsRemotePath ? 1 : 0;
        List<String> ancestors = new ArrayList<>();
        StringBuilder prefix = new StringBuilder();
        for (int index = 0; index < parts.size(); index++) {
            prefix.append('/').append(parts.get(index));
            if (index >= first) {
                ancestors.add(prefix.toString());
            }
        }
        return List.copyOf(ancestors);
    }

    private String sftp(String text) {
        return switch (path) {
            case PosixRemotePath posix -> text;
            case WindowsRemotePath windows -> "/" + text.replace('\\', '/');
        };
    }
}
