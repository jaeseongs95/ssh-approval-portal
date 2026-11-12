package io.github.jaeseongs95.portal.ssh.cli;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Objects;
import java.util.regex.Pattern;
import org.apache.sshd.sftp.client.SftpClient;
import org.apache.sshd.sftp.client.extensions.openssh.OpenSSHPosixRenameExtension;
import org.apache.sshd.sftp.common.SftpConstants;
import org.apache.sshd.sftp.common.SftpException;
import org.apache.sshd.sftp.common.extensions.openssh.PosixRenameExtensionParser;

/**
 * The release of a tool that is in use, kept in the directory of the tool as {@code current} and read and switched over SFTP only (stage 3 design 6.2). The value is
 * the name of the release directory under {@code versions/}. A target whose SFTP server takes {@code symlink} has it as a symbolic link {@code current} to
 * {@code versions/<name>}, made as {@code current.next} and put in place with {@code posix-rename@openssh.com} (one atomic step; where the server does not offer it, the
 * old link is removed and the new one renamed in, which is not atomic and is why the installer reads {@code current} back before it calls a switch done). A target whose
 * server does not take {@code symlink} (the Win32-OpenSSH server does not make a link without a privilege) keeps the same value in a small file {@code current.txt},
 * replaced the same way. Reading looks at the link first and then at the file, and a switch removes the other form, so the two never disagree.
 */
final class CurrentLink {

    private static final String LINK = "current";
    private static final String NEXT_LINK = "current.next";
    private static final String POINTER = "current.txt";
    private static final String NEXT_POINTER = "current.next.txt";
    private static final String VERSIONS = "versions/";
    private static final Pattern SEPARATOR = Pattern.compile("[\\\\/]");
    private static final int POINTER_LIMIT = 4096;

    private final SftpClient client;
    private final String root;

    /**
     * @param client the SFTP client of the session
     * @param root the SFTP path of the directory of the tool
     */
    CurrentLink(SftpClient client, String root) {
        this.client = Objects.requireNonNull(client, "client");
        this.root = Objects.requireNonNull(root, "root");
    }

    /**
     * The name of the release directory that is current; empty when there is none.
     *
     * @throws IOException when the connection fails
     */
    String read() throws IOException {
        try {
            String target = client.readLink(root + "/" + LINK);
            String[] parts = SEPARATOR.split(target.strip());
            return parts[parts.length - 1];
        } catch (SftpException notALink) {
            // no link (there is none, or the server does not make them): the pointer file may hold the value
        }
        try (InputStream in = client.read(root + "/" + POINTER)) {
            return new String(in.readNBytes(POINTER_LIMIT), StandardCharsets.UTF_8).strip();
        } catch (SftpException notThere) {
            if (isMissing(notThere)) {
                return "";
            }
            throw notThere;
        }
    }

    /** Makes the release directory of the name current. */
    void switchTo(String name) throws IOException {
        removeIfThere(root + "/" + NEXT_LINK);
        try {
            client.symLink(root + "/" + NEXT_LINK, VERSIONS + name);
        } catch (SftpException refused) {
            switchWithFile(name);
            return;
        }
        replace(root + "/" + NEXT_LINK, root + "/" + LINK);
        removeIfThere(root + "/" + POINTER);
    }

    /** Makes no release current: the state before the first installation. */
    void clear() throws IOException {
        removeIfThere(root + "/" + LINK);
        removeIfThere(root + "/" + POINTER);
    }

    private void switchWithFile(String name) throws IOException {
        String next = root + "/" + NEXT_POINTER;
        try (OutputStream out = client.write(next)) {
            out.write(name.getBytes(StandardCharsets.UTF_8));
        }
        replace(next, root + "/" + POINTER);
        removeIfThere(root + "/" + LINK);
    }

    /** One atomic step where the server offers {@code posix-rename@openssh.com}; otherwise the target is removed and the new file renamed in. */
    private void replace(String from, String to) throws IOException {
        if (client.getServerExtensions().containsKey(PosixRenameExtensionParser.NAME)) {
            client.getExtension(OpenSSHPosixRenameExtension.class).posixRename(from, to);
            return;
        }
        removeIfThere(to);
        client.rename(from, to);
    }

    private void removeIfThere(String path) throws IOException {
        try {
            client.remove(path);
        } catch (SftpException e) {
            if (!isMissing(e)) {
                throw e;
            }
        }
    }

    private static boolean isMissing(SftpException e) {
        return e.getStatus() == SftpConstants.SSH_FX_NO_SUCH_FILE || e.getStatus() == SftpConstants.SSH_FX_NO_SUCH_PATH;
    }
}
