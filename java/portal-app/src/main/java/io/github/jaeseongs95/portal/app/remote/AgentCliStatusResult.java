package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

import io.github.jaeseongs95.portal.app.cli.RemoteStatus;
import io.github.jaeseongs95.portal.domain.id.Digest;

/** The answer to a status request: what is installed, or that the question could not be asked. */
public sealed interface AgentCliStatusResult permits AgentCliStatusResult.Observed, AgentCliStatusResult.Failed {

    /**
     * What the target shows.
     *
     * @param remote the installation state ({@link RemoteStatus.NotFound} when there is none)
     * @param installationRevision the digest of the installation as seen; an intent names the revision the owner saw
     * @param login whether the tool holds a login
     */
    record Observed(RemoteStatus remote, Digest installationRevision, LoginState login) implements AgentCliStatusResult {

        public Observed {
            Objects.requireNonNull(remote, "remote");
            Objects.requireNonNull(installationRevision, "installationRevision");
            Objects.requireNonNull(login, "login");
        }
    }

    /**
     * The question was not answered: the connection failed or was lost, the time ran out or the owner cancelled. It is a read, so nothing on the target changed.
     *
     * @param cause why
     */
    record Failed(TransferFailureCause cause) implements AgentCliStatusResult {

        public Failed {
            Objects.requireNonNull(cause, "cause");
        }
    }
}
