package io.github.jaeseongs95.portal.app.artifact;

import java.time.Duration;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.file.FileName;
import io.github.jaeseongs95.portal.domain.operation.Elevation;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.operation.UploadProtocol;

/**
 * What an artifact is to be, before it has an id: the request of {@link ArtifactRegistry#reserve}. The size is the declared final size; the limits (64 MiB per
 * file, 512 MiB budget) are the registry's.
 */
public record ArtifactSpec(ArtifactDirection direction, FileName fileName, long sizeBytes, ArtifactOrigin origin, ArtifactDestination destination,
                           OverwriteMode overwrite, Elevation elevation, UploadProtocol protocol, ArtifactRetention retention, Duration timeToLive) {

    public ArtifactSpec {
        Objects.requireNonNull(direction, "direction");
        Objects.requireNonNull(fileName, "fileName");
        Objects.requireNonNull(origin, "origin");
        Objects.requireNonNull(destination, "destination");
        Objects.requireNonNull(overwrite, "overwrite");
        Objects.requireNonNull(elevation, "elevation");
        Objects.requireNonNull(protocol, "protocol");
        Objects.requireNonNull(retention, "retention");
        Objects.requireNonNull(timeToLive, "timeToLive");
        if (sizeBytes < 0) {
            throw new IllegalArgumentException("sizeBytes must not be negative: " + sizeBytes);
        }
        if (timeToLive.isNegative() || timeToLive.isZero()) {
            throw new IllegalArgumentException("timeToLive must be positive: " + timeToLive);
        }
        if (origin instanceof ArtifactOrigin.Staged && destination instanceof ArtifactDestination.Assigned) {
            throw new IllegalArgumentException("A staged file has no destination yet");
        }
    }
}
