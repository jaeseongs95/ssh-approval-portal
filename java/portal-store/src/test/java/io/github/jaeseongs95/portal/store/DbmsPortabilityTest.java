package io.github.jaeseongs95.portal.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.domain.Sort;
import org.springframework.data.jdbc.core.JdbcAggregateOperations;
import org.springframework.data.relational.core.query.Criteria;
import org.springframework.data.relational.core.query.Query;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import io.github.jaeseongs95.portal.domain.operation.ApprovalMode;
import io.github.jaeseongs95.portal.domain.operation.AuditState;
import io.github.jaeseongs95.portal.domain.operation.OperationKind;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.RecoveryReason;
import io.github.jaeseongs95.portal.store.journal.OperationRow;

/**
 * S2-DB-11 to S2-DB-15 and S2-DB-17 (the savepoint helper; the stores that use it are tested with their own cases): what the storage must do on every DBMS the product supports (H2, PostgreSQL, MariaDB, MySQL), written so that the same test class passes on the
 * embedded H2 database of the default run and on the PostgreSQL of the Gradle task {@code externalDbmsTest} (stage 2 design 13.3a). Each test asserts what the migration
 * scripts and the adapters rely on, not what one DBMS happens to do; where DBMSs differ (case folding, padding of CHAR, rounding below a microsecond) the assertion is the part
 * they agree on, and the difference is named in the test.
 *
 * <p>Neighbouring cases that the whole store suite already runs on the external DBMS, by their ids: S2-DB-02 ({@code SchemaChecksTest}: the CASE form of CHECK refuses a value
 * that is in no list, on every enum column), S2-DB-03 ({@code JdbcOperationJournalTest}: the second writer of a version loses, optimistic locking by the version check),
 * S2-DB-05 and S2-DB-06 ({@code JdbcClaimStoreTest}, {@code JdbcClaimStoreConcurrencyTest}: slot and fence collisions between claims).
 */
@StoreTest
class DbmsPortabilityTest {

    private static final String OP_A = "a".repeat(48);
    private static final String OP_B = "b".repeat(48);
    private static final String HEX = "0".repeat(64);
    private static final String STAMP = "TIMESTAMP '2026-11-12 00:00:00'";

    /** The default schema of the embedded H2 database; the external run names its own schema in this system property (ExternalDbmsEnvironment). */
    private static final String SCHEMA_PROPERTY = "portal.test.dbms.schema";
    private static final String H2_DEFAULT_SCHEMA = "PUBLIC";

    private final JdbcTemplate jdbc;
    private final JdbcAggregateOperations aggregates;
    private final PlatformTransactionManager transactions;
    private final Savepoints savepoints;
    private final Flyway flyway;

    DbmsPortabilityTest(JdbcTemplate jdbc, JdbcAggregateOperations aggregates, PlatformTransactionManager transactions, Savepoints savepoints, Flyway flyway) {
        this.savepoints = savepoints;
        this.jdbc = jdbc;
        this.aggregates = aggregates;
        this.transactions = transactions;
        this.flyway = flyway;
    }

    private static OperationRow row(String id, String requestKey, Instant createdAt, Instant updatedAt) {
        return new OperationRow(id, requestKey, "owner", "alpha", HEX, OperationKind.COMMAND, OperationState.ACCEPTED, 1L, ApprovalMode.NOT_DECIDED, "default", null, HEX, null, null,
            createdAt, updatedAt, null, null, null, null, null, null, null, RecoveryReason.NONE, AuditState.NONE);
    }

    private void insertOperation(String id, String requestKey) {
        jdbc.update("INSERT INTO operation (id, request_key, owner_id, target_id, target_revision, kind, state, version, approval_mode, profile, contract_digest, created_at,"
            + " updated_at, recovery_reason, audit_failure) VALUES (?, ?, 'owner', 'alpha', ?, 'COMMAND', 'ACCEPTED', 1, 'NOT_DECIDED', 'default', ?, " + STAMP + ", " + STAMP
            + ", 'NONE', 'NONE')", id, requestKey, HEX, HEX);
    }

    // ---- S2-DB-11: unquoted names ----

    @Test
    @DisplayName("S2-DB-11: tables and columns are created from unquoted names, so the DBMS folds them by its own rule and every statement, written or generated, finds them")
    void unquotedNamesAreFoldedAndFound() {
        insertOperation(OP_A, "request-key-000001");

        // Written in another case than the script: an unquoted name is folded the same way in the script and in the statement.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM Operation WHERE Request_Key = 'request-key-000001' AND OPERATION.State = 'ACCEPTED'", Long.class)).isEqualTo(1L);

        // The stored name is the folded one (upper case in H2, lower case in PostgreSQL): a quoted name in the DBMS's own folding is the table; the folding is read from the driver.
        String[] folding = jdbc.execute((ConnectionCallback<String[]>) connection -> {
            var metadata = connection.getMetaData();
            String quote = metadata.getIdentifierQuoteString();
            String table = metadata.storesUpperCaseIdentifiers() ? "OPERATION" : "operation";
            String column = metadata.storesUpperCaseIdentifiers() ? "REQUEST_KEY" : "request_key";
            return new String[] {quote + table + quote, quote + column + quote};
        });
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM " + folding[0] + " WHERE " + folding[1] + " = 'request-key-000001'", Long.class)).isEqualTo(1L);

        // The statements of Spring Data JDBC (quoting is off, IdentifierQuoting): insert, select by id, select by criteria, update, count, delete.
        OperationRow second = row(OP_B, "request-key-000002", Instant.parse("2026-11-12T01:00:00Z"), Instant.parse("2026-11-12T01:00:00Z"));
        aggregates.insert(second);
        assertThat(aggregates.findById(OP_B, OperationRow.class)).isEqualTo(second);
        assertThat(aggregates.findAll(Query.query(Criteria.where("requestKey").is("request-key-000002")), OperationRow.class)).containsExactly(second);
        OperationRow changed = row(OP_B, "request-key-000002", second.createdAt(), Instant.parse("2026-11-12T02:00:00Z"));
        aggregates.update(changed);
        assertThat(aggregates.findById(OP_B, OperationRow.class)).isEqualTo(changed);
        assertThat(aggregates.count(OperationRow.class)).isEqualTo(2L);
        aggregates.delete(changed);
        assertThat(aggregates.count(OperationRow.class)).isEqualTo(1L);
    }

    // ---- S2-DB-12: savepoint ----

    @Test
    @DisplayName("S2-DB-12: a slot collision inside a nested transaction is rolled back to its savepoint, and the surrounding transaction goes on (on PostgreSQL it would be aborted otherwise)")
    void aSlotCollisionIsRolledBackToItsSavepoint() {
        insertOperation(OP_A, "request-key-000001");
        insertOperation(OP_B, "request-key-000002");
        jdbc.update("INSERT INTO operation_slot (scope, slot_no, operation_id) VALUES ('GLOBAL', 1, ?)", OP_A);

        TransactionTemplate nested = new TransactionTemplate(transactions);
        nested.setPropagationBehavior(TransactionDefinition.PROPAGATION_NESTED);
        assertThatThrownBy(() -> nested.executeWithoutResult(status -> {
            assertThat(status.hasSavepoint()).as("the nested transaction is a savepoint of the surrounding one").isTrue();
            jdbc.update("INSERT INTO operation_slot (scope, slot_no, operation_id) VALUES ('GLOBAL', 1, ?)", OP_B);
        })).isInstanceOf(DuplicateKeyException.class);

        // The surrounding transaction is alive: it reads, and it writes the slot the loser takes next.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM operation_slot", Long.class)).isEqualTo(1L);
        jdbc.update("INSERT INTO operation_slot (scope, slot_no, operation_id) VALUES ('GLOBAL', 2, ?)", OP_B);
        List<Integer> slots = jdbc.queryForList("SELECT slot_no FROM operation_slot WHERE scope = 'GLOBAL' ORDER BY slot_no", Integer.class);
        assertThat(slots).containsExactly(1, 2);
    }

    @Test
    @DisplayName("S2-DB-17: Savepoints undoes all statements of a refused body and no others, rethrows the refusal, and the surrounding transaction goes on")
    void savepointsUndoOnlyTheRefusedBody() {
        insertOperation(OP_A, "request-key-000001");
        insertOperation(OP_B, "request-key-000002");
        jdbc.update("INSERT INTO operation_slot (scope, slot_no, operation_id) VALUES ('GLOBAL', 1, ?)", OP_A);

        assertThatThrownBy(() -> savepoints.run(() -> {
            jdbc.update("INSERT INTO operation_slot (scope, slot_no, operation_id) VALUES ('TARGET:alpha', 1, ?)", OP_B);
            jdbc.update("INSERT INTO operation_slot (scope, slot_no, operation_id) VALUES ('GLOBAL', 1, ?)", OP_B);
        })).isInstanceOf(DuplicateKeyException.class);

        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM operation_slot", Long.class)).as("the first statement of the body is undone with the second").isEqualTo(1L);
        assertThat(savepoints.call(() -> jdbc.update("INSERT INTO operation_slot (scope, slot_no, operation_id) VALUES ('TARGET:alpha', 1, ?)", OP_B))).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM operation_slot", Long.class)).isEqualTo(2L);
    }

    // ---- S2-DB-13: TIMESTAMP(6) ----

    @Test
    @DisplayName("S2-DB-13: an Instant with microseconds is stored in TIMESTAMP(6) and read back unchanged, found by equality, and ordered by the microsecond")
    void microsecondsSurviveTheRoundTrip() {
        Instant micro = Instant.parse("2026-11-12T01:02:03.123456Z");
        Instant nextMicro = micro.plusNanos(1_000);
        aggregates.insert(row(OP_A, "request-key-000001", micro, micro));
        aggregates.insert(row(OP_B, "request-key-000002", nextMicro, nextMicro));

        assertThat(aggregates.findById(OP_A, OperationRow.class).createdAt()).isEqualTo(micro);
        assertThat(aggregates.findById(OP_B, OperationRow.class).createdAt()).isEqualTo(nextMicro);
        assertThat(aggregates.count(Query.query(Criteria.where("createdAt").is(micro)), OperationRow.class)).as("equality on the microsecond (the keyset of the history)").isEqualTo(1L);
        assertThat(aggregates.count(Query.query(Criteria.where("createdAt").lessThan(nextMicro)), OperationRow.class)).as("one microsecond is an order").isEqualTo(1L);
        List<String> ascending = aggregates.findAll(Query.query(Criteria.empty()).sort(Sort.by("createdAt")), OperationRow.class).stream().map(OperationRow::id).toList();
        assertThat(ascending).containsExactly(OP_A, OP_B);
    }

    @Test
    @DisplayName("S2-DB-13: a time finer than a microsecond is cut to the microsecond (H2 and PostgreSQL round it, MariaDB cuts it): the stored value is within one microsecond")
    void belowAMicrosecondIsCut() {
        Instant micro = Instant.parse("2026-11-12T01:02:03.123456Z");
        Instant fine = micro.plusNanos(789);
        aggregates.insert(row(OP_A, "request-key-000001", fine, fine));

        assertThat(aggregates.findById(OP_A, OperationRow.class).createdAt()).isBetween(micro, micro.plusNanos(1_000));
    }

    // ---- S2-DB-14: CHAR ----

    @Test
    @DisplayName("S2-DB-14: a CHAR column keeps a short value and compares equal to it: the padding is blanks only, equality and a join ignore it, and a value over the width is refused")
    void shortValuesInCharColumnsCompareByTheirContent() {
        jdbc.update("INSERT INTO maintenance_release (id, owner_hash) VALUES (1, ?)", "abc");
        jdbc.update("INSERT INTO maintenance_reservation (id, owner_hash) VALUES (1, ?)", "abc");

        // PostgreSQL and H2 return the value padded to 64 characters (JdbcRuntimeCapacityStoreTest sees the padding of CHAR(32)), MariaDB without it: what the DBMS adds is blanks.
        String stored = jdbc.queryForObject("SELECT owner_hash FROM maintenance_release WHERE id = 1", String.class);
        assertThat(stored).startsWith("abc");
        assertThat(stored.substring(3)).isBlank();
        assertThat(stored.stripTrailing()).isEqualTo("abc");

        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM maintenance_release WHERE owner_hash = ?", Long.class, "abc")).isEqualTo(1L);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM maintenance_release WHERE owner_hash = ?", Long.class, "abd")).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM maintenance_release r JOIN maintenance_reservation s ON r.owner_hash = s.owner_hash", Long.class)).isEqualTo(1L);

        String exact = "f".repeat(64);
        jdbc.update("UPDATE maintenance_release SET owner_hash = ?", exact);
        assertThat(jdbc.queryForObject("SELECT owner_hash FROM maintenance_release WHERE id = 1", String.class)).isEqualTo(exact);
        assertThatThrownBy(() -> jdbc.update("UPDATE maintenance_release SET owner_hash = ?", "f".repeat(65))).isInstanceOf(DataIntegrityViolationException.class);
    }

    // ---- S2-DB-15: vendor scripts and schema ----

    @Test
    @DisplayName("S2-DB-15: the migration took the scripts of the DBMS in use ({vendor} is the lower-case product name) and no other vendor's, in the schema the connection works in")
    void theVendorFolderAndTheSchemaAreTheOnesInUse() {
        String vendor = jdbc.execute((ConnectionCallback<String>) connection -> connection.getMetaData().getDatabaseProductName()).toLowerCase(Locale.ROOT);

        List<String> scripts = Arrays.stream(flyway.info().applied()).map(DbmsPortabilityTest::location).toList();
        assertThat(scripts).hasSize(8);
        assertThat(scripts).filteredOn(script -> script.contains("/db/migration/common/")).as("common scripts").hasSize(6);
        assertThat(scripts).filteredOn(script -> script.contains("/db/migration/" + vendor + "/")).as("the scripts of the vendor " + vendor)
            .hasSize(2).allMatch(script -> script.contains("V1_1__long_text_columns.sql") || script.contains("V6_1__maintenance_baseline.sql"));

        // The tables are in the schema the connection works in (SchemaMigrationTest counts them there); the external run names that schema, the embedded database has PUBLIC.
        String expected = System.getProperty(SCHEMA_PROPERTY, H2_DEFAULT_SCHEMA);
        assertThat(jdbc.queryForObject("SELECT CURRENT_SCHEMA", String.class)).isEqualToIgnoringCase(expected);
    }

    /** The script of an applied migration as a path with forward slashes: its relative name and its physical location, whichever Flyway reports the folder in. */
    private static String location(MigrationInfo info) {
        return ("/" + info.getScript() + "|" + info.getPhysicalLocation()).replace('\\', '/');
    }
}
