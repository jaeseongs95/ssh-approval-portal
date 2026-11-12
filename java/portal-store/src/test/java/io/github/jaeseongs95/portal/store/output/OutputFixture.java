package io.github.jaeseongs95.portal.store.output;

import java.sql.Timestamp;
import java.time.Instant;

import javax.sql.DataSource;

import org.springframework.jdbc.core.JdbcTemplate;

import io.github.jaeseongs95.portal.app.output.OutputBinding;
import io.github.jaeseongs95.portal.app.output.OutputTarget;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/**
 * Rows the output tests need around the output tables: an {@code operation} for the foreign key {@code command_output.execution_id}, written as plain SQL with the
 * NOT NULL columns of V1 only. The test double of the journal is not needed here: the output store never reads the operation.
 */
final class OutputFixture {

    private static final Instant CREATED = Instant.parse("2026-11-12T00:00:00Z");

    private final JdbcTemplate jdbc;
    private int counter;

    OutputFixture(DataSource dataSource) {
        this.jdbc = new JdbcTemplate(dataSource);
    }

    /** Inserts one operation and returns its id. */
    OperationId operation() {
        counter++;
        String id = String.format("%048x", counter);
        jdbc.update("INSERT INTO operation (id, request_key, owner_id, target_id, target_revision, kind, state, version, approval_mode, profile, contract_digest,"
            + " created_at, updated_at, recovery_reason, audit_failure) VALUES (?, ?, 'owner', 'alpha', ?, 'COMMAND', 'COMPLETED', 1, 'OWNER', 'profile', ?, ?, ?, 'NONE', 'NONE')",
            id, "request-key-" + counter, "a".repeat(64), "b".repeat(64), Timestamp.from(CREATED), Timestamp.from(CREATED));
        return new OperationId(id);
    }

    /** A binding of a new operation without a target. */
    OutputBinding unbound() {
        return new OutputBinding(operation(), new OutputTarget.Unbound());
    }

    /** A binding of a new operation to the target {@code alpha}. */
    OutputBinding bound() {
        return new OutputBinding(operation(), new OutputTarget.Bound(new TargetId("alpha"), TargetRevision.of("c".repeat(64))));
    }

    /** Removes every row of the output tables and of the operations, for a test that commits (its own transactions are not rolled back). */
    void clean() {
        jdbc.update("DELETE FROM command_output_page");
        jdbc.update("DELETE FROM command_output_format");
        jdbc.update("DELETE FROM command_output");
        jdbc.update("DELETE FROM operation");
    }
}
