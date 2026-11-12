package io.github.jaeseongs95.portal.domain.approval;

/** Whether the bridge is open for requests or reserved for maintenance. The state is kept in the database, so a restart in the middle of maintenance stays in it. */
public sealed interface MaintenanceState permits MaintenanceState.Open, MaintenanceState.Reserved {

    /** Requests are taken. */
    record Open() implements MaintenanceState {
    }

    /** A maintenance owner reserved the bridge; no new request is taken and no queued operation starts. */
    record Reserved() implements MaintenanceState {
    }
}
