package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.net.URI;
import java.util.Objects;

/**
 * Where the owner approves a request (public-contract.mjs:59, {@code approval}). {@code agentSelfApproval} is the contract's promise that an agent cannot approve
 * its own request and is always {@code false}; {@link #of} fills it.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record ApprovalData(String ownerUrl, boolean agentSelfApproval) {

    public ApprovalData {
        Objects.requireNonNull(ownerUrl, "ownerUrl");
        if (!URI.create(ownerUrl).isAbsolute()) {
            throw new IllegalArgumentException("ownerUrl must be an absolute URI");
        }
        if (agentSelfApproval) {
            throw new IllegalArgumentException("The contract promises agentSelfApproval is false");
        }
    }

    /** The approval data of an owner URL, with the promise of the contract filled in. */
    public static ApprovalData of(String ownerUrl) {
        return new ApprovalData(ownerUrl, false);
    }
}
