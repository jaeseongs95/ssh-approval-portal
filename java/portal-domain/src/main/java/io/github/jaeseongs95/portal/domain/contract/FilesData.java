package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Objects;

/**
 * The {@code data} of {@code files} (public-contract.mjs:97, {@code filesData}): the action, the staged file's UUID, the file and, for a copy or a move that was
 * accepted, the operation that places it. A null {@code request} is the wire null (null = wire null): {@code stat} and {@code remove} start no operation, and a
 * placement that was refused or whose admission is unconfirmed has none to show.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record FilesData(FilesActionWire action, String uuid, StagedFile file, OperationData request) {

    public FilesData {
        Objects.requireNonNull(action, "action");
        WireFormat.UUID.require(uuid, "uuid");
        Objects.requireNonNull(file, "file");
    }
}
