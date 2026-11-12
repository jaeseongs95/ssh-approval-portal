package io.github.jaeseongs95.portal.app.storage;

import java.util.Optional;

import io.github.jaeseongs95.portal.app.maintenance.MaintenanceStatus;
import io.github.jaeseongs95.portal.app.maintenance.MaintenanceStore;
import io.github.jaeseongs95.portal.app.maintenance.OwnerHash;
import io.github.jaeseongs95.portal.app.maintenance.PreservationBaseline;

/** The two guards a reaper asks, as plain test classes: whether a maintenance reservation holds the installation, and what the protection of the file stores answers. */
public final class ReapFixtures {

    private ReapFixtures() {
    }

    /** A maintenance store that is only the answer to "is it occupied". */
    public static final class Maintenance implements MaintenanceStore {

        private boolean occupied;

        public void occupy(boolean value) {
            this.occupied = value;
        }

        @Override
        public boolean occupied() {
            return occupied;
        }

        @Override
        public MaintenanceStatus status(OwnerHash owner) {
            return new MaintenanceStatus.Unknown();
        }

        @Override
        public void reserve(OwnerHash owner) {
            occupied = true;
        }

        @Override
        public void saveBaseline(OwnerHash owner, PreservationBaseline baseline) {
            throw new IllegalStateException("not used");
        }

        @Override
        public Optional<PreservationBaseline> baseline(OwnerHash owner) {
            return Optional.empty();
        }

        @Override
        public void release(OwnerHash owner) {
            occupied = false;
        }
    }

    /** A protection whose answer the test sets; it counts the checks, so a test can show that maintenance is asked first and the files after. */
    public static final class Protection implements StorageProtection {

        private ProtectionCheck answer = new ProtectionCheck.Protected();
        private int checks;

        public void answer(ProtectionCheck value) {
            this.answer = value;
        }

        public int checks() {
            return checks;
        }

        @Override
        public ProtectionCheck check() {
            checks++;
            return answer;
        }
    }
}
