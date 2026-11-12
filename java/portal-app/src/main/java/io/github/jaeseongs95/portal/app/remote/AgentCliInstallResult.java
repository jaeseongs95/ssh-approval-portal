package io.github.jaeseongs95.portal.app.remote;

import java.time.Instant;
import java.util.Objects;

import io.github.jaeseongs95.portal.app.cli.CliVersion;

/**
 * How an agent CLI installation ended. As for an upload, only {@link Installed} is a completed operation, and it exists only after the switch to the new version was
 * read back (defect D-0035); a failure after the switch is {@link RolledBack} when the old version is confirmed back, and {@link Unconfirmed} when it is not.
 * {@code cleanupFailures} is the number of removals (old versions, partial directories) that failed; 0 means none failed.
 */
public sealed interface AgentCliInstallResult permits AgentCliInstallResult.Installed, AgentCliInstallResult.Reused, AgentCliInstallResult.Refused,
    AgentCliInstallResult.RolledBack, AgentCliInstallResult.Unconfirmed, AgentCliInstallResult.NotDispatched {

    /**
     * The new version is current and the switch is confirmed.
     *
     * @param version the installed version
     * @param cleanupFailures the failed removals, not negative
     * @param confirmedAt when the switch was confirmed
     */
    record Installed(CliVersion version, int cleanupFailures, Instant confirmedAt) implements AgentCliInstallResult {

        public Installed {
            Objects.requireNonNull(version, "version");
            Objects.requireNonNull(confirmedAt, "confirmedAt");
            requireCount(cleanupFailures);
        }
    }

    /**
     * The same version was already current; nothing was written on the target.
     *
     * @param version the version that is there
     */
    record Reused(CliVersion version) implements AgentCliInstallResult {

        public Reused {
            Objects.requireNonNull(version, "version");
        }
    }

    /**
     * Refused at a confirmed point before the switch; the target keeps the version it had.
     *
     * @param reason why
     */
    record Refused(AgentCliRefusal reason) implements AgentCliInstallResult {

        public Refused {
            Objects.requireNonNull(reason, "reason");
        }
    }

    /**
     * The switch happened and then failed, and the old version is confirmed current again: a failure.
     *
     * @param reason why
     * @param restored the proof that the old version is back
     * @param cleanupFailures the failed removals, not negative
     */
    record RolledBack(AgentCliRefusal reason, RestoreEvidence restored, int cleanupFailures) implements AgentCliInstallResult {

        public RolledBack {
            Objects.requireNonNull(reason, "reason");
            Objects.requireNonNull(restored, "restored");
            requireCount(cleanupFailures);
        }
    }

    /**
     * The state of the target is not known: the owner asks for the status and does not install again.
     *
     * @param cause why it is not known
     * @param cleanupFailures the failed removals, not negative
     */
    record Unconfirmed(UnconfirmedCause cause, int cleanupFailures) implements AgentCliInstallResult {

        public Unconfirmed {
            Objects.requireNonNull(cause, "cause");
            requireCount(cleanupFailures);
        }
    }

    /**
     * Nothing was sent to the target: the connection or the channel failed, the time ran out or the owner cancelled first.
     *
     * @param cause why
     */
    record NotDispatched(TransferFailureCause cause) implements AgentCliInstallResult {

        public NotDispatched {
            Objects.requireNonNull(cause, "cause");
        }
    }

    private static void requireCount(int cleanupFailures) {
        if (cleanupFailures < 0) {
            throw new IllegalArgumentException("cleanupFailures must not be negative");
        }
    }
}
