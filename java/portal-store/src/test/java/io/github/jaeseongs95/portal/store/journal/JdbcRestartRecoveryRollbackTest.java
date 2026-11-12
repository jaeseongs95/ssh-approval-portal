package io.github.jaeseongs95.portal.store.journal;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import io.github.jaeseongs95.portal.domain.error.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Operation;

/** RC-A-487: the recovery is one transaction. This class runs without the slice's own transaction, so that the rollback of the recovery's transaction is the one tested. */
@JournalTest
@Transactional(propagation = Propagation.NOT_SUPPORTED)
class JdbcRestartRecoveryRollbackTest {

    private final JdbcOperationJournal journal;
    private final JdbcRestartRecovery recovery;
    private final JdbcTemplate jdbc;
    private final JournalFixture fx = new JournalFixture();

    JdbcRestartRecoveryRollbackTest(JdbcOperationJournal journal, JdbcRestartRecovery recovery, JdbcTemplate jdbc) {
        this.journal = journal;
        this.recovery = recovery;
        this.jdbc = jdbc;
    }

    @AfterEach
    void removeTheRows() {
        for (String table : List.of("operation_event", "operation_command", "operation")) {
            jdbc.update("DELETE FROM " + table);
        }
    }

    @Test
    @DisplayName("RC-A-487: when one stored operation cannot be recovered, none is: the journal is as it was before the recovery")
    void aFailureRollsBackEveryChange() {
        // Two operations that wait for the owner: the recovery expires both (a queued operation would be left alone and could not show a rollback).
        Operation first = fx.pending(journal, fx.command("first", "alpha", "echo 1", new ConflictKey.None()));
        Operation second = fx.pending(journal, fx.command("second", "alpha", "echo 2", new ConflictKey.None()));
        jdbc.update("DELETE FROM operation_command WHERE operation_id = ?", second.id().value());
        long events = jdbc.queryForObject("SELECT COUNT(*) FROM operation_event", Long.class);

        assertThatThrownBy(() -> recovery.recoverAfterRestart(JournalFixture.NOW.plusSeconds(60))).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(OperationErrorCode.INVALID_OPERATION_RECORD));

        assertThat(jdbc.queryForList("SELECT state FROM operation", String.class)).containsExactly("PENDING", "PENDING");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM operation_event", Long.class)).isEqualTo(events);
        assertThat(first.state().name()).isEqualTo("PENDING");
    }
}
