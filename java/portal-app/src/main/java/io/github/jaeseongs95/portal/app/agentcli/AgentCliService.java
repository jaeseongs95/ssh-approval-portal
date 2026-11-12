package io.github.jaeseongs95.portal.app.agentcli;

import java.time.Clock;
import java.time.Instant;
import java.util.Objects;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import io.github.jaeseongs95.portal.app.cli.AgentCliInstallRecord;
import io.github.jaeseongs95.portal.app.cli.AgentCliRequestStore;
import io.github.jaeseongs95.portal.app.cli.CliVersion;
import io.github.jaeseongs95.portal.app.cli.RemoteState;
import io.github.jaeseongs95.portal.app.cli.RemoteStatus;
import io.github.jaeseongs95.portal.app.file.TransferOutcomes;
import io.github.jaeseongs95.portal.app.remote.AgentCliInstallRequest;
import io.github.jaeseongs95.portal.app.remote.AgentCliInstallResult;
import io.github.jaeseongs95.portal.app.remote.AgentCliInstallerPort;
import io.github.jaeseongs95.portal.app.remote.AgentCliPlan;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.app.target.TargetPlatform;
import io.github.jaeseongs95.portal.app.target.TargetPlatformRegistry;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliCatalog;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliIntent;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProvider;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliRequest;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliTargetBinding;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;
import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchRefusedException;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.operation.CompletionEvidence;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.target.AccessMode;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;

/**
 * Runs an approved agent CLI installation (stage 3 design 6.2, defect D-0035). The order is fixed and each step is the guard of the next:
 * <ol>
 * <li><b>The plan and the intent.</b> The stored release is the one the registry announced (its digest still matches), the plan has not expired, the target is enabled and
 * is still the revision and the profile the operation was approved for, and the intent that these make hashes to the digest the owner approved. A failure is a
 * {@code DispatchRefusedException}: nothing was fetched and nothing was sent.</li>
 * <li><b>The catalog.</b> The package bytes come from the {@link AgentReleaseCatalog}; a package that cannot be had is a failure with the target untouched.</li>
 * <li><b>The installer.</b> {@link AgentCliInstallerPort#install} checks the package against the release's checksum itself, so bytes from a wrong catalog are never installed.</li>
 * <li><b>The journal.</b> What the target reported is recorded in the install record, and the answer becomes the outcome the operation settles from.</li>
 * </ol>
 *
 * <p>Only {@code Installed} (the switch was read back) and {@code Reused} (the same version is current) can complete the operation, each with its own evidence; a failure
 * after the switch with the old version confirmed back is a failure, and a result that is not known is {@code UNKNOWN}. No record of the target is kept on the target (the
 * journal is the only one), so there is no receipt that could say "completed" for a switch that was not confirmed. A {@code cleanupFailures} of 0 is "nothing failed to clean up"
 * (decision of design 1.3; 2.x refused a 0 and so made it unknown).
 */
@Service
public class AgentCliService {

    private static final Logger LOG = LoggerFactory.getLogger(AgentCliService.class);

    private final AgentCliCatalog providers;
    private final AgentReleaseCatalog releases;
    private final AgentCliInstallerPort installer;
    private final AgentCliRequestStore store;
    private final TargetPlatformRegistry platforms;
    private final TransferOutcomes outcomes;
    private final Digester digester;
    private final Clock clock;
    private final TransferLimits limits;

    public AgentCliService(AgentCliCatalog providers, AgentReleaseCatalog releases, AgentCliInstallerPort installer, AgentCliRequestStore store,
                           TargetPlatformRegistry platforms, TransferOutcomes outcomes, Digester digester, Clock clock, TransferLimits limits) {
        this.providers = providers;
        this.releases = releases;
        this.installer = installer;
        this.store = store;
        this.platforms = platforms;
        this.outcomes = outcomes;
        this.digester = digester;
        this.clock = clock;
        this.limits = limits;
    }

    /**
     * Runs the installation. Throws {@link DispatchRefusedException} before anything is fetched or sent when the plan, the intent, the expiry or the target binding does not
     * hold, and {@link RequestRefusedException} ({@code TARGET_CAPABILITY_UNSUPPORTED}) for a target that cannot install an agent CLI.
     */
    public ExecutionOutcome install(AgentCliRun run, ExecutionControl control) {
        Objects.requireNonNull(run, "run");
        Objects.requireNonNull(control, "control");
        AgentCliInstallRecord record = store.findByOperation(run.operation()).orElseThrow(() -> refusal(DispatchReason.PRIVATE_PLAN, DispatchStage.CLI_GUARD));
        AgentCliIntent intent = verified(run, record);
        ResolvedTarget target = run.target();
        if (!target.target().capabilities().agentCli()) {
            throw new RequestRefusedException(RequestErrorCode.TARGET_CAPABILITY_UNSUPPORTED);
        }

        if (!(releases.fetch(record.release()) instanceof TarballResult.Fetched fetched)) {
            return outcomes.failedAtKnownPoint(true, "The package of the release could not be fetched; nothing was sent to the target.");
        }

        TargetPlatform platform = platforms.platformOf(target.target().os());
        AgentCliPlan plan = platform.agentCliPlan(intent, record.release());
        RemoteTarget remote = new RemoteTarget(target.target().id(), run.approvedRevision(), run.approvedProfile(), AccessMode.READ_WRITE);
        AgentCliInstallResult result = installer.install(new AgentCliInstallRequest(remote, plan, fetched.tarball(), limits), control);
        return settle(run, record.release(), result);
    }

    /** The intent of the stored plan, when the plan, the expiry, the target and the intent digest all hold. */
    private AgentCliIntent verified(AgentCliRun run, AgentCliInstallRecord record) {
        AgentRelease release = record.release();
        if (!release.digestMatches(digester)) {
            throw refusal(DispatchReason.PRIVATE_PLAN, DispatchStage.CLI_GUARD);
        }
        Instant now = clock.instant();
        if (!now.isBefore(record.planExpiresAt())) {
            throw refusal(DispatchReason.PLAN_EXPIRED, DispatchStage.CLI_GUARD);
        }
        ResolvedTarget target = run.target();
        if (!target.target().isEnabled() || !target.revision().equals(run.approvedRevision()) || !target.target().writeProfile().equals(run.approvedProfile())) {
            throw refusal(DispatchReason.TARGET_CHANGED, DispatchStage.TARGET_GUARD);
        }
        AgentCliProvider provider = providers.provider(record.provider());
        AgentCliRequest request = new AgentCliRequest(target.target().id(), run.approvedRevision(), run.approvedProfile(), record.provider(), record.action(),
            release.releaseDigestLabel(), record.expectedInstallationRevision(), run.requestKey());
        AgentCliIntent intent;
        try {
            intent = AgentCliIntent.of(provider, request, new AgentCliTargetBinding(target.target().id(), target.revision(), target.target().writeProfile(), true), release,
                record.planExpiresAt(), now, digester);
        } catch (IllegalArgumentException e) {
            throw new DispatchRefusedException(DispatchFailure.refused(DispatchReason.PRIVATE_PLAN, DispatchStage.CLI_GUARD), e);
        }
        if (!("sha256:" + intent.intentDigest().hex()).equals(record.intentDigest())) {
            throw refusal(DispatchReason.PRIVATE_PLAN, DispatchStage.CLI_GUARD);
        }
        return intent;
    }

    /** What the target reported is recorded in the install record, and becomes the outcome; a result that never reached the target records nothing. */
    private ExecutionOutcome settle(AgentCliRun run, AgentRelease release, AgentCliInstallResult result) {
        CliVersion announced = new CliVersion(release.version());
        return switch (result) {
            case AgentCliInstallResult.Installed installed -> recorded(run, new RemoteStatus.Known(RemoteState.COMPLETED, installed.version(), installed.cleanupFailures()),
                outcomes.completed(new CompletionEvidence.FilePublished(installed.confirmedAt(), release.releaseDigest()), "Installed " + installed.version().value() + "."));
            case AgentCliInstallResult.Reused reused -> recorded(run, new RemoteStatus.Known(RemoteState.REUSED, reused.version(), 0),
                outcomes.completed(new CompletionEvidence.CommandExited(0), "The same version " + reused.version().value() + " was already installed; nothing was written."));
            case AgentCliInstallResult.Refused refused -> recorded(run, new RemoteStatus.Failed(announced, 0),
                outcomes.failedAtKnownPoint(true, "INSTALL_FAILED: " + refused.reason() + "; the target keeps the version it had."));
            case AgentCliInstallResult.RolledBack rolledBack -> recorded(run, new RemoteStatus.Failed(announced, rolledBack.cleanupFailures()),
                outcomes.failedAtKnownPoint(false, "INSTALL_FAILED: " + rolledBack.reason() + "; the switch was undone and the old version is current again."));
            case AgentCliInstallResult.Unconfirmed unconfirmed -> recorded(run, new RemoteStatus.Known(RemoteState.UNKNOWN, announced, unconfirmed.cleanupFailures()),
                outcomes.unknownAfterEffect("The result of the installation is not known; ask for the status before installing again."));
            case AgentCliInstallResult.NotDispatched notDispatched -> outcomes.notDispatched(notDispatched.cause(), limits.deadline());
        };
    }

    /**
     * The status is recorded before the outcome is returned. A journal that cannot be written is logged and does not change the outcome: the operation's own settlement is
     * the authoritative record, and an install that happened is never turned into a failure because a side record could not be written.
     */
    private ExecutionOutcome recorded(AgentCliRun run, RemoteStatus status, ExecutionOutcome outcome) {
        try {
            store.recordRemote(run.operation(), status);
        } catch (RuntimeException e) {
            LOG.warn("The remote status of the installation " + run.operation().value() + " could not be recorded", e);
        }
        return outcome;
    }

    private DispatchRefusedException refusal(DispatchReason reason, DispatchStage stage) {
        return new DispatchRefusedException(DispatchFailure.refused(reason, stage));
    }
}
