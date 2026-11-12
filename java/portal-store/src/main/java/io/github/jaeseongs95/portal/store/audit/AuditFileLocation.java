package io.github.jaeseongs95.portal.store.audit;

import java.nio.file.Path;
import java.util.Objects;

/** Where the JSONL audit file lives. The server assembles this value from its storage roots and registers it as a bean; the audit log does not decide the path. */
public record AuditFileLocation(Path file) {

    public AuditFileLocation {
        Objects.requireNonNull(file, "file");
    }
}
