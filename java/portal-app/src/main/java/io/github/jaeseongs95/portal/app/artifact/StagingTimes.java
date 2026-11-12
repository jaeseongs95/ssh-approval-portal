package io.github.jaeseongs95.portal.app.artifact;

import java.time.Duration;
import java.util.Objects;

/**
 * How long an artifact that nobody submitted or fetched stays (2.x {@code artifacts.mjs}): an upload that was begun and never submitted, and a download that is ready and
 * waits to be saved. The use case puts the value into the {@link ArtifactSpec}; the registry only adds it to the creation time. The assembly builds one bean from its
 * settings (stage 4 binds them); the defaults are the 2.x values.
 *
 * @param upload the time-to-live of an upload (10 minutes in 2.x)
 * @param download the time-to-live of a download (1 hour in 2.x)
 */
public record StagingTimes(Duration upload, Duration download) {

    public static final Duration DEFAULT_UPLOAD = Duration.ofMinutes(10);
    public static final Duration DEFAULT_DOWNLOAD = Duration.ofHours(1);

    public StagingTimes {
        Objects.requireNonNull(upload, "upload");
        Objects.requireNonNull(download, "download");
        if (upload.isNegative() || upload.isZero() || download.isNegative() || download.isZero()) {
            throw new IllegalArgumentException("A staging time must be positive");
        }
    }

    /** The 2.x values. */
    public static StagingTimes defaults() {
        return new StagingTimes(DEFAULT_UPLOAD, DEFAULT_DOWNLOAD);
    }
}
