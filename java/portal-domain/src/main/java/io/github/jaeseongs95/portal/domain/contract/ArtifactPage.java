package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Objects;

/**
 * The {@code data} of {@code artifact-read} (public-contract.mjs:66-67, {@code artifactPage}): one base64 page of a downloaded file. {@code bytes} is the size of
 * the page before encoding (at most 256 KiB), {@code totalBytes} the size of the file (at most 64 MiB), {@code nextOffset} where the next page starts.
 * {@code encoding} is the constant {@code "base64"}; {@link #ENCODING} names it.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record ArtifactPage(String id, String artifactId, String fileName, String encoding, String data, long offsetBytes, long bytes, long nextOffset, long totalBytes,
                           String sha256, boolean eof, long expiresAt) {

    /** The only encoding of a page. */
    public static final String ENCODING = "base64";

    public ArtifactPage {
        WireFormat.IDENTIFIER.require(id, "id");
        WireFormat.IDENTIFIER.require(artifactId, "artifactId");
        Objects.requireNonNull(fileName, "fileName");
        if (!ENCODING.equals(encoding)) {
            throw new IllegalArgumentException("encoding must be " + ENCODING);
        }
        Objects.requireNonNull(data, "data");
        WireNumber.NON_NEGATIVE.require(offsetBytes, "offsetBytes");
        WireNumber.CHUNK_BYTES.require(bytes, "bytes");
        WireNumber.NON_NEGATIVE.require(nextOffset, "nextOffset");
        WireNumber.ARTIFACT_BYTES.require(totalBytes, "totalBytes");
        WireFormat.DIGEST.require(sha256, "sha256");
        WireNumber.NON_NEGATIVE.require(expiresAt, "expiresAt");
    }
}
