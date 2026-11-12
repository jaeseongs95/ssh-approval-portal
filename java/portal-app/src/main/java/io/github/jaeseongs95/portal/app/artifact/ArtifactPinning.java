package io.github.jaeseongs95.portal.app.artifact;

import java.util.Objects;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.operation.OperationState;

/**
 * When a submitted operation lets go of its artifact (S3-AR-07). {@code submit} pins the artifact for as long as the operation depends on it; this class gives it back to
 * the expiry calculation once the operation reached a <em>final</em> state (completed, failed, cancelled, denied, expired). An {@code UNKNOWN} operation keeps its
 * artifact pinned: the owner reconciles it and may need the bytes to compare with the target, and nothing runs again by itself.
 */
@Component
public class ArtifactPinning {

    private final ArtifactRegistry registry;

    public ArtifactPinning(ArtifactRegistry registry) {
        this.registry = registry;
    }

    /** Unpins {@code artifact} when {@code state} is final; does nothing otherwise. Repeating it is harmless. */
    public void operationSettled(ArtifactId artifact, OperationState state) {
        Objects.requireNonNull(artifact, "artifact");
        Objects.requireNonNull(state, "state");
        if (state.isFinal()) {
            registry.unpin(artifact, state == OperationState.DENIED ? UnpinReason.OPERATION_REFUSED : UnpinReason.OPERATION_SETTLED);
        }
    }
}
