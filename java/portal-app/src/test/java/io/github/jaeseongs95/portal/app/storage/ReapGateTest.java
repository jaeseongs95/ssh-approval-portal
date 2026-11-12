package io.github.jaeseongs95.portal.app.storage;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** The one rule of whether a reaper may delete (S3-UC-06): a maintenance reservation (RC-A-173) and a failing protection of the file stores (RC-B-004) hold it back. */
class ReapGateTest {

    private final ReapFixtures.Maintenance maintenance = new ReapFixtures.Maintenance();
    private final ReapFixtures.Protection protection = new ReapFixtures.Protection();
    private final ReapGate gate = new ReapGate(maintenance, protection);

    @Test
    @DisplayName("S3-UC-06: with no maintenance and a protected store the reap is allowed")
    void aQuietInstallationMayReap() {
        assertThat(gate.permission()).isEqualTo(new ReapPermission.Allowed());
    }

    @Test
    @DisplayName("S3-UC-06 / RC-A-173: a maintenance reservation holds the reap back, and the files are not even looked at")
    void maintenanceHoldsTheReapBack() {
        maintenance.occupy(true);

        assertThat(gate.permission()).isEqualTo(new ReapPermission.Suspended(ReapPermission.SuspendReason.MAINTENANCE));
        assertThat(protection.checks()).as("maintenance is answered before any file is touched").isZero();

        maintenance.occupy(false);
        assertThat(gate.permission()).as("the reap resumes when the reservation is released").isEqualTo(new ReapPermission.Allowed());
    }

    @Test
    @DisplayName("S3-UC-06 / RC-B-004: a protection that fails forbids the reap, whichever store it is, and an allowed answer returns when the protection is back")
    void aFailingProtectionForbidsTheReap() {
        for (StorageArea area : StorageArea.values()) {
            protection.answer(new ProtectionCheck.Unprotected(area, new IOException("the folder is open to others")));

            assertThat(gate.permission()).as(area.name()).isEqualTo(new ReapPermission.Suspended(ReapPermission.SuspendReason.PROTECTION_FAILED));
        }
        protection.answer(new ProtectionCheck.Protected());
        assertThat(gate.permission()).isEqualTo(new ReapPermission.Allowed());
    }
}
