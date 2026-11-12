package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

/** How opening a forwarded channel ended (stage 5 uses it; stage 3 fixes the name and the shape). */
public sealed interface ForwardOpenResult permits ForwardOpenResult.Opened, ForwardOpenResult.Refused, ForwardOpenResult.Unconfirmed {

    /** The channel is open. */
    record Opened(ForwardHandle handle) implements ForwardOpenResult {

        public Opened {
            Objects.requireNonNull(handle, "handle");
        }
    }

    /** The channel was not opened and nothing was sent through it. */
    record Refused(TransferFailureCause cause) implements ForwardOpenResult {

        public Refused {
            Objects.requireNonNull(cause, "cause");
        }
    }

    /** It is not known whether the channel is open. */
    record Unconfirmed(UnconfirmedCause cause) implements ForwardOpenResult {

        public Unconfirmed {
            Objects.requireNonNull(cause, "cause");
        }
    }
}
