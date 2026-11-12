package io.github.jaeseongs95.portal.domain.operation;

/** Why a recovery changed the operation, if one did: the bridge restarted while it was in flight, or it was imported from a 2.x history. */
public enum RecoveryReason {
    NONE, BRIDGE_RESTART, LEGACY_IMPORT
}
