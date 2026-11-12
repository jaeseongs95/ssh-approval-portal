package io.github.jaeseongs95.portal.store.maintenance;

import java.util.Objects;
import java.util.Optional;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.jdbc.core.JdbcAggregateOperations;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import io.github.jaeseongs95.portal.app.maintenance.MaintenanceStatus;
import io.github.jaeseongs95.portal.app.maintenance.MaintenanceStore;
import io.github.jaeseongs95.portal.app.maintenance.OwnerHash;
import io.github.jaeseongs95.portal.app.maintenance.PreservationBaseline;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;

/**
 * {@link MaintenanceStore} over the two one-row tables {@code maintenance_reservation} and {@code maintenance_release} (design 8.2 V6, 2.x {@code maintenance-state.mjs}).
 * The row id is always 1: the primary key and a CHECK make a second reservation impossible, so two racing reservers are told apart by the key and not by a lock.
 * Rows are written with {@link JdbcAggregateOperations#insert}, which inserts without the new-or-existing check because the id is given (Spring Data JDBC API:
 * "useful if the client provides an id for new aggregate roots").
 */
@Repository
public class JdbcMaintenanceStore implements MaintenanceStore {

    private static final int THE_ROW = 1;

    private final MaintenanceReservationRowRepository reservations;
    private final MaintenanceReleaseRowRepository releases;
    private final JdbcAggregateOperations aggregates;

    public JdbcMaintenanceStore(MaintenanceReservationRowRepository reservations, MaintenanceReleaseRowRepository releases, JdbcAggregateOperations aggregates) {
        this.reservations = reservations;
        this.releases = releases;
        this.aggregates = aggregates;
    }

    @Override
    @Transactional(readOnly = true)
    public MaintenanceStatus status(OwnerHash owner) {
        if (reservations.findById(THE_ROW).filter(row -> Objects.equals(row.ownerHash(), owner.value())).isPresent()) {
            return new MaintenanceStatus.Reserved();
        }
        if (releases.findById(THE_ROW).filter(row -> Objects.equals(row.ownerHash(), owner.value())).isPresent()) {
            return new MaintenanceStatus.Released();
        }
        return new MaintenanceStatus.Unknown();
    }

    @Override
    @Transactional(readOnly = true)
    public boolean occupied() {
        return reservations.existsById(THE_ROW);
    }

    @Override
    @Transactional
    public void reserve(OwnerHash owner) {
        if (releases.findById(THE_ROW).filter(row -> Objects.equals(row.ownerHash(), owner.value())).isPresent()) {
            // The owner of the last release may not reserve again (2.x maintenance-state.mjs:25). The contract has no code of its own for this yet (reported as a need).
            throw new RequestRefusedException(RequestErrorCode.REQUEST_REFUSED);
        }
        try {
            aggregates.insert(new MaintenanceReservationRow(THE_ROW, owner.value(), null));
        } catch (DuplicateKeyException e) {
            throw new RequestRefusedException(RequestErrorCode.MAINTENANCE_ACTIVE, e);
        }
    }

    @Override
    @Transactional
    public void saveBaseline(OwnerHash owner, PreservationBaseline baseline) {
        if (reservations.storeBaselineOnce(owner.value(), baseline.text()) != 1) {
            // Not the holder, or a baseline was stored already: nothing changed.
            throw new RequestRefusedException(RequestErrorCode.REQUEST_REFUSED);
        }
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<PreservationBaseline> baseline(OwnerHash owner) {
        return reservations.findById(THE_ROW).filter(row -> Objects.equals(row.ownerHash(), owner.value())).map(MaintenanceReservationRow::baseline)
            .map(PreservationBaseline::new);
    }

    @Override
    @Transactional
    public void release(OwnerHash owner) {
        reservations.findById(THE_ROW).filter(row -> Objects.equals(row.ownerHash(), owner.value()))
            .orElseThrow(() -> new RequestRefusedException(RequestErrorCode.REQUEST_REFUSED));
        reservations.deleteById(THE_ROW);
        releases.deleteById(THE_ROW);
        aggregates.insert(new MaintenanceReleaseRow(THE_ROW, owner.value()));
    }
}
