package io.github.jaeseongs95.portal.server.assembly;

import java.nio.file.Path;
import java.util.Objects;

import io.github.jaeseongs95.portal.app.artifact.StagingTimes;
import io.github.jaeseongs95.portal.store.artifact.ArtifactLimits;

/**
 * What the file stores need to know from the installation: the folders of the artifact bytes and of the command output bytes, the audit file, the limits of the artifact
 * store and how long an artifact that nobody used stays. No folder has a default here: where the bytes live is the installation's choice (the product is installed on the host
 * of an arbitrary user), and the stores refuse a folder that others can use.
 *
 * <p>Stage 3 receives the value through the constructor of the assembly (a test builds one); stage 4 replaces it by a {@code @ConfigurationProperties} record of the
 * {@code bridge.*} prefix that has the same components (decision D3-12), and nothing that uses it changes.
 *
 * @param artifactsFolder the folder of the artifact payload files
 * @param outputsFolder the folder of the command output files
 * @param auditFile the JSONL audit file
 * @param artifactLimits the budget, the per-file limit, the chunk size and the disk margin of the artifact store
 * @param stagingTimes how long an unsubmitted upload and a ready download stay
 */
public record StorageSettings(Path artifactsFolder, Path outputsFolder, Path auditFile, ArtifactLimits artifactLimits, StagingTimes stagingTimes) {

    public StorageSettings {
        Objects.requireNonNull(artifactsFolder, "artifactsFolder");
        Objects.requireNonNull(outputsFolder, "outputsFolder");
        Objects.requireNonNull(auditFile, "auditFile");
        Objects.requireNonNull(artifactLimits, "artifactLimits");
        Objects.requireNonNull(stagingTimes, "stagingTimes");
    }
}
