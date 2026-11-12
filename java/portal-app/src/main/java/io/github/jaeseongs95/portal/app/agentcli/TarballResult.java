package io.github.jaeseongs95.portal.app.agentcli;

import java.util.Objects;

import io.github.jaeseongs95.portal.app.remote.PayloadSource;

/** The answer of {@link AgentReleaseCatalog#fetch}: the package to read, or that it is not available. */
public sealed interface TarballResult permits TarballResult.Fetched, TarballResult.Unavailable {

    /** The package bytes; each {@code open()} of the source reads them from the start. */
    record Fetched(PayloadSource tarball) implements TarballResult {

        public Fetched {
            Objects.requireNonNull(tarball, "tarball");
        }
    }

    /** The registry could not be reached or does not hold the release. */
    record Unavailable() implements TarballResult {
    }
}
