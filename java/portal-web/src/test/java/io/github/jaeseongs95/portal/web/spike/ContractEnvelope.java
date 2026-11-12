package io.github.jaeseongs95.portal.web.spike;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import java.util.Objects;

/**
 * The Contract 2.0 envelope {contractVersion, ok, data, error} and the data of the {@code targets} tool, as records that guard their own invariants in the compact
 * constructor (Principles 3.0): the rule of public-contract.mjs {@code responseSchema} (ok means data and no error, not ok means error and no data) is a property
 * of the type, so no caller can build an envelope that breaks it.
 *
 * <p>{@code @JsonInclude(ALWAYS)}: the contract has the keys {@code error} and {@code defaultTarget} even when they are null. The mapper Spring AI builds for MCP
 * leaves nulls out (case P-10), so the records say it themselves.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
record ContractEnvelope<T>(String contractVersion, boolean ok, T data, ErrorData error) {

    static final String CONTRACT_VERSION = "2.0";

    ContractEnvelope {
        Objects.requireNonNull(contractVersion, "contractVersion");
        if (ok ? data == null || error != null : data != null || error == null) {
            throw new IllegalArgumentException("Expected data or error");
        }
    }

    static <T> ContractEnvelope<T> success(T data) {
        return new ContractEnvelope<>(CONTRACT_VERSION, true, data, null);
    }

    @JsonInclude(JsonInclude.Include.ALWAYS)
    record ErrorData(String code, boolean retryable, String executionAttempted) {
    }

    @JsonInclude(JsonInclude.Include.ALWAYS)
    record Limits(int commandBytes, int sourceBytes, int artifactBytes, int chunkBytes, int outputPageBytes, int maxWaitMs) {
        Limits {
            if (commandBytes <= 0 || sourceBytes <= 0 || artifactBytes <= 0 || chunkBytes <= 0 || outputPageBytes <= 0 || maxWaitMs <= 0) {
                throw new IllegalArgumentException("Limits are positive");
            }
        }
    }

    @JsonInclude(JsonInclude.Include.ALWAYS)
    record Approval(String ownerUrl, boolean agentSelfApproval) {
    }

    @JsonInclude(JsonInclude.Include.ALWAYS)
    record TargetsData(List<Object> targets, String defaultTarget, Limits limits, Approval approval) {
    }
}
