package io.github.jaeseongs95.portal.app.storage;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.maintenance.MaintenanceStore;

/**
 * The one place that decides whether a reaper may delete (RC-A-173, RC-B-004). Both reapers (artifacts and outputs) ask it before every run, so the two rules are not
 * written twice: a maintenance reservation holds the reap back (the files, the metadata and the accounting must stay as they were until it is released), and so does a
 * guard of the file stores that fails (the portal never deletes bytes it cannot safely look at). The state is read each time; this class keeps none.
 */
@Component
public class ReapGate {

    private static final Logger LOG = LoggerFactory.getLogger(ReapGate.class);

    private final MaintenanceStore maintenance;
    private final StorageProtection protection;

    public ReapGate(MaintenanceStore maintenance, StorageProtection protection) {
        this.maintenance = maintenance;
        this.protection = protection;
    }

    /** Maintenance first (it needs no file I/O), then the protection of the stores. */
    public ReapPermission permission() {
        if (maintenance.occupied()) {
            return new ReapPermission.Suspended(ReapPermission.SuspendReason.MAINTENANCE);
        }
        if (protection.check() instanceof ProtectionCheck.Unprotected unprotected) {
            LOG.error("The " + unprotected.area() + " folder is not protected; no expired bytes are deleted", unprotected.cause());
            return new ReapPermission.Suspended(ReapPermission.SuspendReason.PROTECTION_FAILED);
        }
        return new ReapPermission.Allowed();
    }
}
