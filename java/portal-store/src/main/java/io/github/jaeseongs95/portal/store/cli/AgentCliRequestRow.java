package io.github.jaeseongs95.portal.store.cli;

import java.time.Instant;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

import io.github.jaeseongs95.portal.app.cli.RemoteState;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliAction;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProviderId;

/**
 * Table {@code agent_cli_request}: the install request of an AGENT_CLI operation (1:1 with the {@code operation} row, which holds the key, owner, target and time).
 * {@code releaseDigest} and {@code intentDigest} are the 71-character labels ({@code sha256:} and 64 hex characters); {@code expectedInstallationRevision} is the 64 hex
 * characters. The four {@code remote*} columns are the nullable parts of the persistence record: all {@code null} means the remote has not reported.
 */
@Table("agent_cli_request")
public record AgentCliRequestRow(@Id String operationId, AgentCliProviderId provider, AgentCliAction action, String packageName, String releaseVersion,
                                 String releaseTarball, String releaseIntegrity, String releaseDigest, String expectedInstallationRevision, String intentDigest,
                                 Instant planExpiresAt, RemoteState remoteState, String remoteVersion, RemoteError remoteError, Integer remoteCleanupFailures) {

    /** The same request with another remote status. */
    AgentCliRequestRow withRemote(RemoteState state, String version, RemoteError error, Integer cleanupFailures) {
        return new AgentCliRequestRow(operationId, provider, action, packageName, releaseVersion, releaseTarball, releaseIntegrity, releaseDigest,
            expectedInstallationRevision, intentDigest, planExpiresAt, state, version, error, cleanupFailures);
    }
}
