package io.github.jaeseongs95.portal.store.maintenance;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.Import;

import io.github.jaeseongs95.portal.app.maintenance.MaintenanceStatus;
import io.github.jaeseongs95.portal.app.maintenance.OwnerHash;
import io.github.jaeseongs95.portal.app.maintenance.PreservationBaseline;
import io.github.jaeseongs95.portal.domain.contract.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestRefusedException;
import io.github.jaeseongs95.portal.store.Savepoints;
import io.github.jaeseongs95.portal.store.StoreTest;

@StoreTest
@Import(JdbcMaintenanceStore.class)
class JdbcMaintenanceStoreTest {

    private static final OwnerHash OWNER_A = new OwnerHash("a".repeat(64));
    private static final OwnerHash OWNER_B = new OwnerHash("b".repeat(64));

    private final JdbcMaintenanceStore store;
    private final Savepoints savepoints;

    JdbcMaintenanceStoreTest(JdbcMaintenanceStore store, Savepoints savepoints) {
        this.store = store;
        this.savepoints = savepoints;
    }

    /**
     * A reservation that the store refuses because the key of the one row is taken, in its own savepoint: PostgreSQL aborts the transaction at the failed insert (SQL state
     * 25P02 for every later statement), and a refusal from a {@code @Transactional} method marks the joined transaction rollback-only; the rollback to the savepoint
     * clears both, so the test can go on in the same transaction (S2-DB-17).
     */
    private void refusedReservation(OwnerHash owner) {
        assertThatThrownBy(() -> savepoints.run(() -> store.reserve(owner))).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(RequestErrorCode.MAINTENANCE_ACTIVE));
    }

    @Test
    @DisplayName("RC-B-008: an owner that holds the reservation excludes every other reserver, and the store reports the holder")
    void theHolderExcludesOthers() {
        assertThat(store.occupied()).isFalse();
        store.reserve(OWNER_A);

        assertThat(store.occupied()).isTrue();
        assertThat(store.status(OWNER_A)).isInstanceOf(MaintenanceStatus.Reserved.class);
        assertThat(store.status(OWNER_B)).isInstanceOf(MaintenanceStatus.Unknown.class);
        refusedReservation(OWNER_B);
        refusedReservation(OWNER_A);
    }

    @Test
    @DisplayName("S2-DB-17: a refused reservation (the key of the one row is taken) leaves the same transaction usable: it reads, releases and reserves again")
    void aRefusedReservationLeavesTheTransactionUsable() {
        store.reserve(OWNER_A);
        refusedReservation(OWNER_B);
        refusedReservation(OWNER_B);

        assertThat(store.status(OWNER_A)).isInstanceOf(MaintenanceStatus.Reserved.class);
        store.release(OWNER_A);
        store.reserve(OWNER_B);
        assertThat(store.status(OWNER_B)).isInstanceOf(MaintenanceStatus.Reserved.class);
    }

    @Test
    @DisplayName("RC-B-008: an owner that did not reserve cannot release; the holder can, and then the store reports the release")
    void onlyTheHolderReleases() {
        store.reserve(OWNER_A);

        assertThatThrownBy(() -> store.release(OWNER_B)).isInstanceOf(RequestRefusedException.class);
        assertThat(store.occupied()).isTrue();

        store.release(OWNER_A);
        assertThat(store.occupied()).isFalse();
        assertThat(store.status(OWNER_A)).isInstanceOf(MaintenanceStatus.Released.class);
    }

    @Test
    @DisplayName("RC-B-008: the owner of the last release may not reserve again; another owner may")
    void aReleasedOwnerIsUsed() {
        store.reserve(OWNER_A);
        store.release(OWNER_A);

        assertThatThrownBy(() -> store.reserve(OWNER_A)).isInstanceOf(RequestRefusedException.class);
        store.reserve(OWNER_B);
        assertThat(store.status(OWNER_B)).isInstanceOf(MaintenanceStatus.Reserved.class);
    }

    @Test
    @DisplayName("RC-B-008: the last release is replaced by the next release (one row)")
    void theLastReleaseIsOverwritten() {
        store.reserve(OWNER_A);
        store.release(OWNER_A);
        store.reserve(OWNER_B);
        store.release(OWNER_B);

        assertThat(store.status(OWNER_B)).isInstanceOf(MaintenanceStatus.Released.class);
        assertThat(store.status(OWNER_A)).isInstanceOf(MaintenanceStatus.Unknown.class);
    }

    @Test
    @DisplayName("RC-B-008: the baseline is written once, by the holder only, and is read back unchanged")
    void theBaselineIsWrittenOnce() {
        store.reserve(OWNER_A);
        PreservationBaseline baseline = new PreservationBaseline("{\"operations\":3}");

        assertThat(store.baseline(OWNER_A)).isEmpty();
        assertThatThrownBy(() -> store.saveBaseline(OWNER_B, baseline)).isInstanceOf(RequestRefusedException.class);
        store.saveBaseline(OWNER_A, baseline);
        assertThat(store.baseline(OWNER_A)).contains(baseline);
        assertThatThrownBy(() -> store.saveBaseline(OWNER_A, new PreservationBaseline("{}"))).isInstanceOf(RequestRefusedException.class);
        assertThat(store.baseline(OWNER_A)).contains(baseline);
        assertThat(store.baseline(OWNER_B)).isEmpty();
    }
}
