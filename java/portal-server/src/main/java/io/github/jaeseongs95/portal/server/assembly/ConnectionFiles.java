package io.github.jaeseongs95.portal.server.assembly;

import java.nio.file.Path;
import java.util.Objects;

/**
 * The two files of the SSH side that the installation chooses: the TOML file of the connection profiles and the file the recorded host keys are kept in. No path has a
 * default (the product is installed on the host of an arbitrary user). Stage 4 replaces this value by a {@code @ConfigurationProperties} record of the {@code bridge.*} prefix
 * with the same components.
 *
 * @param profileFile the TOML file of the profiles; it must exist and be private to its owner
 * @param knownHosts the file of the recorded host keys (created when the first key is recorded)
 */
public record ConnectionFiles(Path profileFile, Path knownHosts) {

    public ConnectionFiles {
        Objects.requireNonNull(profileFile, "profileFile");
        Objects.requireNonNull(knownHosts, "knownHosts");
    }
}
