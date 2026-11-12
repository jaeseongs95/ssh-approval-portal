package io.github.jaeseongs95.portal.app.output;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.OperationId;

/** What an output is bound to: the execution (an operation) and its target. Only the owner of that execution may read it. */
public record OutputBinding(OperationId executionId, OutputTarget target) {

    public OutputBinding {
        Objects.requireNonNull(executionId, "executionId");
        Objects.requireNonNull(target, "target");
    }
}
