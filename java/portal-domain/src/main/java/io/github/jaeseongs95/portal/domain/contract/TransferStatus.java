package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Objects;

/**
 * The {@code data} of {@code artifact-status} (public-contract.mjs:64, {@code transferStatus}): the state of an upload, the transfer while it is not yet submitted
 * and the request once it is. A null {@code transfer} or {@code request} is the wire null (null = wire null).
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record TransferStatus(TransferStateWire state, TransferData transfer, OperationData request) {

    public TransferStatus {
        Objects.requireNonNull(state, "state");
    }
}
