package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.app.remote.FileDiagnostic;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import java.util.Objects;

/**
 * What looking at a path on the server showed: no file there, a regular file, a refusal (a link, a directory, a missing parent, no permission), or no answer at all
 * because the connection was lost. The four are different facts and the transfer answers each of them differently.
 */
sealed interface PathInspection permits PathInspection.Absent, PathInspection.Present, PathInspection.Refused, PathInspection.Lost {

    /** The directories are all there and are plain directories, and there is no file at the path. */
    record Absent() implements PathInspection {
    }

    /**
     * A regular file is at the path.
     *
     * @param state what the server reports about it
     */
    record Present(LeafState state) implements PathInspection {
        public Present {
            Objects.requireNonNull(state, "state");
        }
    }

    /**
     * The path cannot be used.
     *
     * @param code why
     * @param diagnostic the closed fact behind the code
     */
    record Refused(TransferErrorCode code, FileDiagnostic diagnostic) implements PathInspection {
        public Refused {
            Objects.requireNonNull(code, "code");
            Objects.requireNonNull(diagnostic, "diagnostic");
        }
    }

    /** The connection was lost while the path was being looked at. */
    record Lost() implements PathInspection {
    }
}
