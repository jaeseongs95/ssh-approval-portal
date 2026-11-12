package io.github.jaeseongs95.portal.store;

import java.nio.file.Path;
import java.util.Objects;

/**
 * The folders of the file stores: where the artifact bytes and the command output bytes live. The product's assembly (portal-server) creates one bean from its
 * {@code @ConfigurationProperties}; this module has no settings of its own (the property prefix belongs to the server).
 */
public record StorageRoots(Path artifacts, Path outputs) {

    public StorageRoots {
        Objects.requireNonNull(artifacts, "artifacts");
        Objects.requireNonNull(outputs, "outputs");
    }
}
