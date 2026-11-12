package io.github.jaeseongs95.portal.app.file;

import java.util.Objects;

import org.springframework.stereotype.Service;

import io.github.jaeseongs95.portal.app.artifact.ArtifactImporter;
import io.github.jaeseongs95.portal.app.artifact.ArtifactSpec;
import io.github.jaeseongs95.portal.app.artifact.ImportResult;
import io.github.jaeseongs95.portal.app.output.OutputId;
import io.github.jaeseongs95.portal.app.output.OutputPayloadStore;
import io.github.jaeseongs95.portal.domain.id.Digest;

/**
 * Imports the spool of a command output as an artifact (design 1.3, cases RC-A-182 and RC-A-183, S3-AR-06). The digest of the spool is read from the file first
 * ({@link OutputPayloadStore#streamDigest}); the import reads the same file ({@link OutputPayloadStore#openStream}), hashes the bytes it stores and compares the two, so a
 * spool that changed on the disk between the two reads, or bytes that were damaged on the way, fail the import and leave nothing behind. The capacity is reserved before the
 * spool is opened, as for every import.
 */
@Service
public class OutputStreamImport {

    private final OutputPayloadStore outputs;
    private final ArtifactImporter importer;

    public OutputStreamImport(OutputPayloadStore outputs, ArtifactImporter importer) {
        this.outputs = outputs;
        this.importer = importer;
    }

    /**
     * Imports the spool of {@code output}. {@code spec} declares the size of the spool (the bytes {@code openStream} delivers) and where the artifact goes; an output that
     * has no spool throws {@code RequestRefusedException(OUTPUT_CAPTURE_FAILED)} before anything is reserved.
     */
    public ImportResult importSpool(OutputId output, ArtifactSpec spec) {
        Objects.requireNonNull(output, "output");
        Objects.requireNonNull(spec, "spec");
        Digest expected = outputs.streamDigest(output);
        return importer.importStream(spec, () -> outputs.openStream(output), expected);
    }
}
