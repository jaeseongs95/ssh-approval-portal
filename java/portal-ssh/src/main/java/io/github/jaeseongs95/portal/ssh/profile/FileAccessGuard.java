package io.github.jaeseongs95.portal.ssh.profile;

import java.io.IOException;
import java.nio.file.FileStore;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.List;
import java.util.Objects;

import org.springframework.stereotype.Component;

/**
 * Picks the {@link FileAccessRule} that the file store of a path supports and applies it to a file and to the folder that holds it. The rules are injected as a
 * {@code List} in their {@code @Order}, so a rule for another kind of file store is a new bean and no change here. A file store that no rule supports is refused with an
 * {@link IOException}: the protection of a file is never "not checked".
 */
@Component
public class FileAccessGuard {

    private final List<FileAccessRule> rules;

    public FileAccessGuard(List<FileAccessRule> rules) {
        this.rules = List.copyOf(rules);
    }

    /**
     * Checks the file first and then its folder, as 2.x did (PF-04). The first refusal is the answer; otherwise the first warning; otherwise {@link AccessVerdict.Private}.
     */
    public AccessVerdict inspect(Path file, Protection protection) throws IOException {
        Objects.requireNonNull(file, "file");
        Objects.requireNonNull(protection, "protection");
        FileAccessRule rule = ruleFor(file);
        AccessVerdict fileVerdict = rule.inspect(file, protection);
        if (fileVerdict instanceof AccessVerdict.Refused) {
            return fileVerdict;
        }
        Path folder = file.toAbsolutePath().getParent();
        if (folder == null) {
            return fileVerdict;
        }
        AccessVerdict folderVerdict = rule.inspect(folder, protection);
        if (folderVerdict instanceof AccessVerdict.Refused || fileVerdict instanceof AccessVerdict.Private) {
            return folderVerdict;
        }
        return fileVerdict;
    }

    /** Creates the folder of the file, if it is missing, and the empty file, if it is missing; what is created is private to its owner. What exists is left as it is. */
    public void createPrivateFile(Path file) throws IOException {
        Objects.requireNonNull(file, "file");
        FileAccessRule rule = ruleFor(file);
        Path folder = file.toAbsolutePath().getParent();
        if (folder != null) {
            rule.createFolder(folder);
        }
        rule.createFile(file.toAbsolutePath());
    }

    private FileAccessRule ruleFor(Path path) throws IOException {
        Path existing = path.toAbsolutePath();
        while (existing.getParent() != null && !Files.exists(existing, LinkOption.NOFOLLOW_LINKS)) {
            existing = existing.getParent();
        }
        FileStore store = Files.getFileStore(existing);
        for (FileAccessRule rule : rules) {
            if (rule.supports(store)) {
                return rule;
            }
        }
        throw new IOException("The file store " + store + " supports neither permission bits (posix) nor an access control list (acl)");
    }
}
