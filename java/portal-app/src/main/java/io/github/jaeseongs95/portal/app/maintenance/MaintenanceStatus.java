package io.github.jaeseongs95.portal.app.maintenance;

/**
 * What the store knows about one owner: this owner holds the reservation now, this owner's reservation was released, or the owner is not known. The three are told
 * apart because a caller that asks again after a crash must not mistake "released" for "never reserved" (2.x {@code maintenance-state.mjs:36-43}).
 */
public sealed interface MaintenanceStatus permits MaintenanceStatus.Reserved, MaintenanceStatus.Released, MaintenanceStatus.Unknown {

    record Reserved() implements MaintenanceStatus {
    }

    record Released() implements MaintenanceStatus {
    }

    record Unknown() implements MaintenanceStatus {
    }
}
