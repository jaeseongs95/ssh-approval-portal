package io.github.jaeseongs95.portal.app.file;

import java.util.Objects;

import org.springframework.stereotype.Service;

import io.github.jaeseongs95.portal.app.artifact.ArtifactDestination;
import io.github.jaeseongs95.portal.app.artifact.ArtifactPayloadStore;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRecord;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRegistry;
import io.github.jaeseongs95.portal.app.artifact.ArtifactState;
import io.github.jaeseongs95.portal.app.artifact.BindingKind;
import io.github.jaeseongs95.portal.app.artifact.ContentDigest;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.FileAccess;
import io.github.jaeseongs95.portal.app.remote.PathPolicyBinding;
import io.github.jaeseongs95.portal.app.remote.PermissionRequest;
import io.github.jaeseongs95.portal.app.remote.PermissionResult;
import io.github.jaeseongs95.portal.app.remote.PermissionSupport;
import io.github.jaeseongs95.portal.app.remote.RemoteFileTransfer;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.app.remote.UploadRequest;
import io.github.jaeseongs95.portal.app.remote.UploadResult;
import io.github.jaeseongs95.portal.app.target.TargetPlatform;
import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchRefusedException;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.file.FileBinding;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.UploadInput;
import io.github.jaeseongs95.portal.domain.target.AccessMode;

/**
 * Publishes an approved artifact on a target and says how it ended (design 4.1 to 4.6, defects D-0035 and D-0013). The use case checks that the stored artifact is the one
 * the owner approved, opens its bytes (outside any transaction: the adapter reads the payload, it never sees the registry), and turns the transfer's answer into the
 * outcome the operation settles from. Nothing here sends a request twice.
 *
 * <p>{@link UploadResult.Published} is the only answer that can complete the operation, and it carries the evidence ({@code FilePublished}) only when the digest it
 * confirmed is the digest that was approved; every other answer is a failure (target unchanged, or restored) or an unknown outcome the owner reconciles (see
 * {@link TransferOutcomes}). There is no code path that builds a completed outcome without the evidence.
 *
 * <p>Permission bits: a target whose platform cannot set them (Windows) refuses an explicit mode before anything is sent, with {@code TARGET_CAPABILITY_UNSUPPORTED}; a
 * request that names no mode is published with the platform's default and the step is skipped where there is none (design 4.6).
 */
@Service
public class UploadService {

    private final ArtifactRegistry registry;
    private final ArtifactPayloadStore payloads;
    private final RemoteFileTransfer transfer;
    private final TransferSupport support;
    private final TransferOutcomes outcomes;
    private final TransferLimits limits;

    public UploadService(ArtifactRegistry registry, ArtifactPayloadStore payloads, RemoteFileTransfer transfer, TransferSupport support, TransferOutcomes outcomes,
                         TransferLimits limits) {
        this.registry = registry;
        this.payloads = payloads;
        this.transfer = transfer;
        this.support = support;
        this.outcomes = outcomes;
        this.limits = limits;
    }

    /**
     * Runs the upload. Throws {@link DispatchRefusedException} (file guard) before anything is sent when the stored artifact is not what was approved, and
     * {@link RequestRefusedException} ({@code TARGET_CAPABILITY_UNSUPPORTED}) when the request needs a capability the target lacks; the adapter's guard may throw the
     * same exception before its first write.
     */
    public ExecutionOutcome upload(UploadJob job, ExecutionControl control) {
        Objects.requireNonNull(job, "job");
        Objects.requireNonNull(control, "control");
        UploadInput input = job.input();
        TargetPlatform platform = support.platformOf(job.target());
        requireApproved(registry.find(input.artifactId()).orElseThrow(this::fileGuardRefusal), input);
        FileAccess access = support.accessOf(platform, input.elevation());
        PermissionSupport permissionSupport = platform.permissionSupport();
        if (job.permission() instanceof FilePermission.Explicit && permissionSupport instanceof PermissionSupport.Unsupported) {
            throw new RequestRefusedException(RequestErrorCode.TARGET_CAPABILITY_UNSUPPORTED);
        }
        RemoteTarget remote = new RemoteTarget(job.target().target().id(), job.approvedRevision(), job.target().target().writeProfile(), AccessMode.READ_WRITE);
        PathPolicyBinding pathPolicy = platform.pathPolicy(job.target().target());
        UploadRequest request = new UploadRequest(remote, input.remotePath(), input.sizeBytes(), input.sha256(), input.overwrite(), access, pathPolicy, limits);

        UploadResult result = transfer.upload(request, () -> payloads.open(input.artifactId()), control);

        if (result instanceof UploadResult.Published published && published.sha256().equals(input.sha256())
            && job.permission() instanceof FilePermission.Explicit explicit) {
            PermissionResult applied = transfer.applyPermissions(new PermissionRequest(remote, input.remotePath(), explicit.mode(), permissionSupport, access, pathPolicy,
                limits), control);
            return outcomes.uploadWithPermission(published, applied);
        }
        return outcomes.upload(result, input.sha256(), limits.deadline());
    }

    /** The artifact must still be the file that was approved: ready, the same size and digest, the same path, overwrite rule, rights and target binding. */
    private void requireApproved(ArtifactRecord artifact, UploadInput input) {
        boolean sealed = artifact.content() instanceof ContentDigest.Sealed digest && digest.sha256().equals(input.sha256());
        boolean sameFile = artifact.state() == ArtifactState.READY && sealed && artifact.spec().sizeBytes() == input.sizeBytes();
        boolean sameRequest = artifact.spec().overwrite() == input.overwrite() && artifact.spec().elevation() == input.elevation()
            && destinationMatches(artifact.spec().destination(), input);
        if (!sameFile || !sameRequest) {
            throw fileGuardRefusal();
        }
    }

    /** An artifact that has a destination must have the approved path and, when the operation is bound to a target, the same target and revision. */
    private boolean destinationMatches(ArtifactDestination destination, UploadInput input) {
        return switch (destination) {
            case ArtifactDestination.Unassigned unassigned -> !(input.binding() instanceof FileBinding.Bound);
            case ArtifactDestination.Assigned assigned -> assigned.path().equals(input.remotePath()) && bindingMatches(assigned, input.binding());
        };
    }

    private boolean bindingMatches(ArtifactDestination.Assigned assigned, FileBinding binding) {
        return switch (binding) {
            case FileBinding.Unbound unbound -> assigned.binding() == BindingKind.UNBOUND;
            case FileBinding.Bound bound -> assigned.binding() == BindingKind.BOUND && assigned.targetId().equals(bound.binding().targetId())
                && assigned.targetRevision().equals(bound.binding().targetRevision());
        };
    }

    private DispatchRefusedException fileGuardRefusal() {
        return new DispatchRefusedException(DispatchFailure.refused(DispatchReason.UNKNOWN, DispatchStage.FILE_GUARD));
    }
}
