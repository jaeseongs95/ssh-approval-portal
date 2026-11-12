package io.github.jaeseongs95.portal.app.file;

import java.util.Objects;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.artifact.ArtifactPinning;
import io.github.jaeseongs95.portal.app.operation.TerminalOperationListener;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.UploadInput;

/**
 * Lets go of the artifact of an upload when its operation reaches a final state (S3-AR-07): the copy that {@code submit} pinned is given back to the expiry calculation. It is a
 * listener of {@link TerminalOperationListener}, so the dispatcher does not know about artifacts. An operation of another kind is not its business; an {@code UNKNOWN} one keeps
 * the artifact (see {@link ArtifactPinning}); telling it twice, as a restart does, is harmless.
 */
@Component
public class UploadArtifactRelease implements TerminalOperationListener {

    private final ArtifactPinning pinning;

    public UploadArtifactRelease(ArtifactPinning pinning) {
        this.pinning = Objects.requireNonNull(pinning, "pinning");
    }

    @Override
    public void onTerminal(Operation operation) {
        if (operation.input() instanceof UploadInput input) {
            pinning.operationSettled(input.artifactId(), operation.state());
        }
    }
}
