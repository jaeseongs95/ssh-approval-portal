package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.app.remote.FileDiagnostic;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import java.util.Objects;

/** What the allowed-root rule says about a path before the server is asked anything: go on, or refuse with a code. */
public sealed interface PolicyVerdict permits PolicyVerdict.Cleared, PolicyVerdict.Refused {

    /** The rule lets the path through (it is inside the root, the rule is lifted for the target, or the target has no such rule). */
    record Cleared() implements PolicyVerdict {
    }

    /**
     * The rule refuses.
     *
     * @param code {@code PATH_OUTSIDE_ALLOWED_ROOT}, {@code PATH_POLICY_UNSUPPORTED} or {@code INVALID_REQUEST}
     * @param diagnostic the closed fact behind the code
     */
    record Refused(TransferErrorCode code, FileDiagnostic diagnostic) implements PolicyVerdict {
        public Refused {
            Objects.requireNonNull(code, "code");
            Objects.requireNonNull(diagnostic, "diagnostic");
        }
    }
}
