package io.github.jaeseongs95.portal.store;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * S2-DB-01: the real Flyway migration of the product on an empty embedded H2 database (no compatibility mode): the 28 tables of design 8.2 and 13.2 exist, the scripts
 * are the common ones plus the two of the vendor {@code h2}, and a second run changes nothing.
 */
@StoreTest
class SchemaMigrationTest {

    /** The 28 tables: V1 13 (operation journal with slot and fence), V2 3, V3 3, V4 4, V5 1, V6 4. */
    static final Set<String> TABLES = Set.of("operation", "operation_event", "operation_command", "operation_source", "operation_upload", "operation_download",
        "operation_decision", "operation_decision_attempt", "operation_decision_command", "operation_result", "operation_legacy", "operation_slot", "operation_fence",
        "artifact", "artifact_chunk", "staged_action", "command_output", "command_output_format", "command_output_page", "command_policy", "command_policy_rule",
        "command_policy_name", "command_policy_threshold", "agent_cli_request", "maintenance_reservation", "maintenance_release", "runtime_capacity",
        "runtime_capacity_target");

    private final JdbcTemplate jdbc;
    private final Flyway flyway;

    SchemaMigrationTest(JdbcTemplate jdbc, Flyway flyway) {
        this.jdbc = jdbc;
        this.flyway = flyway;
    }

    @Test
    @DisplayName("S2-DB-01: the migration of an empty database creates exactly the 28 tables")
    void createsTheTwentyEightTables() {
        List<String> names = jdbc.queryForList(
            "SELECT LOWER(TABLE_NAME) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = CURRENT_SCHEMA AND TABLE_TYPE = 'BASE TABLE'", String.class);
        Set<String> product = new TreeSet<>(names);
        product.remove("flyway_schema_history");

        assertThat(TABLES).hasSize(28);
        assertThat(product).isEqualTo(new TreeSet<>(TABLES));
    }

    @Test
    @DisplayName("S2-DB-01 / D3-04: the applied scripts are V1, V1.1, V2 to V6, V6.1 and V7 (the execution timeline), and a second migration runs nothing")
    void aSecondRunChangesNothing() {
        List<String> applied = Arrays.stream(flyway.info().applied()).map(info -> info.getVersion().getVersion()).toList();
        assertThat(applied).containsExactly("1", "1.1", "2", "3", "4", "5", "6", "6.1", "7");
        assertThat(Arrays.stream(flyway.info().applied()).map(MigrationInfo::getState).allMatch(state -> state.isApplied())).isTrue();
        assertThat(flyway.info().pending()).isEmpty();

        assertThat(flyway.migrate().migrationsExecuted).isZero();
    }

    @Test
    @DisplayName("S2-DB-01: the command policy exists after the migration at revision 0")
    void thePolicySeedRowExists() {
        assertThat(jdbc.queryForObject("SELECT revision FROM command_policy WHERE id = 1", Long.class)).isZero();
    }

    @Test
    @DisplayName("S2-DB-01: every table of the schema is empty except the policy seed")
    void theTablesAreEmpty() {
        for (String table : TABLES) {
            long expected = "command_policy".equals(table) ? 1 : 0;
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Long.class)).as(table).isEqualTo(expected);
        }
    }
}
