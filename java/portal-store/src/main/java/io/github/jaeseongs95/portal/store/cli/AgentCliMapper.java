package io.github.jaeseongs95.portal.store.cli;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.cli.AgentCliInstallRecord;
import io.github.jaeseongs95.portal.app.cli.CliVersion;
import io.github.jaeseongs95.portal.app.cli.RemoteState;
import io.github.jaeseongs95.portal.app.cli.RemoteStatus;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.OperationId;

/** Converts between the app record {@link AgentCliInstallRecord} and the persistence row {@link AgentCliRequestRow}. */
@Component
class AgentCliMapper {

    private static final String DIGEST_LABEL = "sha256:";

    /** The row of a new request, with the remote status of the record. */
    AgentCliRequestRow row(AgentCliInstallRecord record) {
        AgentRelease release = record.release();
        AgentCliRequestRow base = new AgentCliRequestRow(record.operationId().value(), record.provider(), record.action(), release.packageName(), release.version(),
            release.tarball(), release.integrity(), release.releaseDigestLabel(), record.expectedInstallationRevision().hex(), record.intentDigest(),
            record.planExpiresAt(), null, null, null, null);
        return withRemote(base, record.remote());
    }

    /** The row with the columns of the remote status replaced; a cleanup count of 0 is stored as null because the CHECK wants a positive count. */
    AgentCliRequestRow withRemote(AgentCliRequestRow row, RemoteStatus status) {
        return switch (status) {
            case RemoteStatus.NotReported notReported -> row.withRemote(null, null, null, null);
            case RemoteStatus.NotFound notFound -> row.withRemote(RemoteState.NOT_FOUND, null, null, null);
            case RemoteStatus.Known known -> row.withRemote(known.state(), known.version().value(), null, cleanupColumn(known.cleanupFailures()));
            case RemoteStatus.Failed failed -> row.withRemote(RemoteState.FAILED, failed.version().value(), RemoteError.INSTALL_FAILED,
                cleanupColumn(failed.cleanupFailures()));
        };
    }

    /** The record of a stored row. */
    AgentCliInstallRecord record(AgentCliRequestRow row) {
        AgentRelease release = new AgentRelease(row.provider(), row.packageName(), row.releaseVersion(), row.releaseTarball(), row.releaseIntegrity(),
            new Digest(digestHex(row.releaseDigest())));
        return new AgentCliInstallRecord(new OperationId(row.operationId()), row.provider(), row.action(), release, new Digest(row.expectedInstallationRevision()),
            row.intentDigest(), row.planExpiresAt(), remote(row));
    }

    /** The remote status of a stored row; no state means the remote has not reported. */
    RemoteStatus remote(AgentCliRequestRow row) {
        RemoteState state = row.remoteState();
        if (state == null) {
            return new RemoteStatus.NotReported();
        }
        int cleanupFailures = row.remoteCleanupFailures() == null ? 0 : row.remoteCleanupFailures();
        return switch (state) {
            case NOT_FOUND -> new RemoteStatus.NotFound();
            case FAILED -> new RemoteStatus.Failed(version(row), cleanupFailures);
            case UNKNOWN, PREPARING, INSTALLING, COMPLETED, REUSED -> new RemoteStatus.Known(state, version(row), cleanupFailures);
        };
    }

    private CliVersion version(AgentCliRequestRow row) {
        if (row.remoteVersion() == null) {
            throw new IllegalStateException("The stored remote status " + row.remoteState() + " of operation " + row.operationId() + " has no version");
        }
        return new CliVersion(row.remoteVersion());
    }

    private Integer cleanupColumn(int cleanupFailures) {
        return cleanupFailures > 0 ? Integer.valueOf(cleanupFailures) : null;
    }

    private String digestHex(String label) {
        if (!label.startsWith(DIGEST_LABEL)) {
            throw new IllegalStateException("A stored release digest starts with " + DIGEST_LABEL);
        }
        return label.substring(DIGEST_LABEL.length());
    }
}
