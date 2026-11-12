package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

/** How starting a streamed command ended (stage 5 uses it; stage 3 fixes the name and the shape). */
public sealed interface StreamOpenResult permits StreamOpenResult.Opened, StreamOpenResult.Refused, StreamOpenResult.Unconfirmed {

    /** The command runs and its streams are open. */
    record Opened(StreamHandle handle) implements StreamOpenResult {

        public Opened {
            Objects.requireNonNull(handle, "handle");
        }
    }

    /** The command did not start. */
    record Refused(TransferFailureCause cause) implements StreamOpenResult {

        public Refused {
            Objects.requireNonNull(cause, "cause");
        }
    }

    /** It is not known whether the command started. */
    record Unconfirmed(UnconfirmedCause cause) implements StreamOpenResult {

        public Unconfirmed {
            Objects.requireNonNull(cause, "cause");
        }
    }
}
