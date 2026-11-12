package io.github.jaeseongs95.portal.app.cli;

import java.util.Objects;

/**
 * What is known of the installation on the target. The rules of 2.x ({@code agent-cli-state.mjs:51-58}) are the shape of the variants: a version exists unless the CLI
 * was not found, and only a failed installation has an error ({@code INSTALL_FAILED}). Four variants instead of nullable fields.
 */
public sealed interface RemoteStatus permits RemoteStatus.NotReported, RemoteStatus.NotFound, RemoteStatus.Known, RemoteStatus.Failed {

    /** The target has reported nothing yet. */
    record NotReported() implements RemoteStatus {
    }

    record NotFound() implements RemoteStatus {
    }

    /** The CLI is present or being installed; {@code cleanupFailures} is 0 when nothing failed to clean up. */
    record Known(RemoteState state, CliVersion version, int cleanupFailures) implements RemoteStatus {

        public Known {
            Objects.requireNonNull(state, "state");
            Objects.requireNonNull(version, "version");
            if (state == RemoteState.NOT_FOUND || state == RemoteState.FAILED) {
                throw new IllegalArgumentException("Known is neither NOT_FOUND nor FAILED: " + state);
            }
            if (cleanupFailures < 0) {
                throw new IllegalArgumentException("cleanupFailures must not be negative");
            }
        }
    }

    /** The installation failed; the error is always {@code INSTALL_FAILED}. */
    record Failed(CliVersion version, int cleanupFailures) implements RemoteStatus {

        public Failed {
            Objects.requireNonNull(version, "version");
            if (cleanupFailures < 0) {
                throw new IllegalArgumentException("cleanupFailures must not be negative");
            }
        }
    }
}
