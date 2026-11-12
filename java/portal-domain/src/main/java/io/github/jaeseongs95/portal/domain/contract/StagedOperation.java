package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Objects;

/** One placement of a staged file on a target (public-contract.mjs:69-71, an entry of {@code stagedFile.operations}): the key and id of its operation and its state. */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record StagedOperation(String operationKey, FilePlacementWire action, String requestId, StagedOperationStateWire state) {

    public StagedOperation {
        WireFormat.KEY.require(operationKey, "operationKey");
        Objects.requireNonNull(action, "action");
        WireFormat.IDENTIFIER.require(requestId, "requestId");
        Objects.requireNonNull(state, "state");
    }
}
