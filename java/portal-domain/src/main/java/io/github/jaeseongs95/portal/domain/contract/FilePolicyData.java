package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Objects;

/**
 * The file path policy of a target (public-contract.mjs:45-47, {@code policy}). {@code osPermissionsEnforced}, {@code pathSafetyEnforced} and
 * {@code elevationRequiresExplicitRequest} are promises of the contract and are always {@code true}; {@link #of} fills them. A null component is the wire null
 * (null = wire null): a target without a configured root has no {@code allowedRoot} and no observation time.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record FilePolicyData(boolean testServerConfigured, boolean testServerActive, FileAccessModeWire mode, String allowedRoot, Long allowedRootObservedAt,
                             boolean osPermissionsEnforced, boolean pathSafetyEnforced, boolean elevationRequiresExplicitRequest) {

    public FilePolicyData {
        Objects.requireNonNull(mode, "mode");
        WireNumber.NON_NEGATIVE.requireOrNull(allowedRootObservedAt, "allowedRootObservedAt");
        if (!osPermissionsEnforced || !pathSafetyEnforced || !elevationRequiresExplicitRequest) {
            throw new IllegalArgumentException("The contract promises osPermissionsEnforced, pathSafetyEnforced and elevationRequiresExplicitRequest are true");
        }
    }

    /** A file policy with the three promises of the contract filled in. */
    public static FilePolicyData of(boolean testServerConfigured, boolean testServerActive, FileAccessModeWire mode, String allowedRoot, Long allowedRootObservedAt) {
        return new FilePolicyData(testServerConfigured, testServerActive, mode, allowedRoot, allowedRootObservedAt, true, true, true);
    }
}
