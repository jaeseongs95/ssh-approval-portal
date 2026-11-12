package io.github.jaeseongs95.portal.app.output;

import java.util.Objects;

/**
 * The answer of {@link OutputManifestStore#find}; 2.x had {@code pending}, {@code ready}, {@code unavailable} and a derived {@code expired}, and a missing row was an
 * error. A reader needs to tell all five apart, so each is a variant.
 */
public sealed interface OutputLookup permits OutputLookup.Ready, OutputLookup.Pending, OutputLookup.Unavailable, OutputLookup.Expired, OutputLookup.Missing {

    /** The output can be read. */
    record Ready(OutputManifest manifest) implements OutputLookup {

        public Ready {
            Objects.requireNonNull(manifest, "manifest");
        }
    }

    /** The execution has not finished writing it. */
    record Pending() implements OutputLookup {
    }

    /** The output was given up (capture failed or the execution was abandoned); there are no bytes to read. */
    record Unavailable() implements OutputLookup {
    }

    /** The retention time has passed. */
    record Expired() implements OutputLookup {
    }

    /** No such output. */
    record Missing() implements OutputLookup {
    }
}
