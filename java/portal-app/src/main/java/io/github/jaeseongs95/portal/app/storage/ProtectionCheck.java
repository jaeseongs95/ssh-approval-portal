package io.github.jaeseongs95.portal.app.storage;

import java.util.Objects;

/** The answer of {@link StorageProtection#check}: the folders are private to their owner, or the first folder that is not (or could not be checked) and why. */
public sealed interface ProtectionCheck permits ProtectionCheck.Protected, ProtectionCheck.Unprotected {

    /** Every folder is a real folder that only its owner can use. */
    record Protected() implements ProtectionCheck {
    }

    /**
     * A folder is not safe, or the check itself failed. The portal does not read or write bytes there, and it deletes none (case RC-B-004: a guard that fails keeps the
     * expired bytes).
     *
     * @param area the folder
     * @param cause what the check threw
     */
    record Unprotected(StorageArea area, Throwable cause) implements ProtectionCheck {

        public Unprotected {
            Objects.requireNonNull(area, "area");
            Objects.requireNonNull(cause, "cause");
        }
    }
}
