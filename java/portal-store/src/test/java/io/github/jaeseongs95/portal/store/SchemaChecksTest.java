package io.github.jaeseongs95.portal.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.stream.Stream;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;

import io.github.jaeseongs95.portal.domain.failure.DispatchReason;
import io.github.jaeseongs95.portal.domain.failure.DispatchStage;
import io.github.jaeseongs95.portal.domain.operation.ApprovalMode;
import io.github.jaeseongs95.portal.domain.operation.DecisionKind;
import io.github.jaeseongs95.portal.domain.operation.DecisionReason;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import io.github.jaeseongs95.portal.domain.operation.OperationKind;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.OutcomeCertainty;
import io.github.jaeseongs95.portal.domain.operation.RecoveryReason;
import io.github.jaeseongs95.portal.domain.operation.RemoteState;

/**
 * S2-DB-02: the CHECK constraints of the enum columns. For each column the one value that the fixture holds is changed to a value that is in no list (rejected), and
 * for the columns that map one to one to a domain enum every constant of that enum is accepted, so a constant that was added to the enum and not to the CHECK is found
 * here. Primary key, foreign key and unique constraints are tested at the end.
 */
@StoreTest
class SchemaChecksTest {

    private static final String OP = "a".repeat(48);
    private static final String ARTIFACT = "b".repeat(48);
    private static final String OUTPUT = "c".repeat(48);
    private static final String HEX = "0".repeat(64);
    private static final String STAMP = "TIMESTAMP '2026-11-12 00:00:00'";

    private final JdbcTemplate jdbc;

    SchemaChecksTest(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @BeforeEach
    void rows() {
        jdbc.update("INSERT INTO operation (id, request_key, owner_id, target_id, target_revision, kind, state, version, approval_mode, profile, contract_digest, created_at,"
            + " updated_at, recovery_reason, audit_failure, outcome_certainty, reconciliation) VALUES ('" + OP + "', 'request-key-000001', 'owner', 'alpha', '" + HEX
            + "', 'COMMAND', 'QUEUED', 1, 'OWNER', 'default', '" + HEX + "', " + STAMP + ", " + STAMP + ", 'NONE', 'NONE', 'EXITED', 'NOT_REQUIRED')");
        jdbc.update("INSERT INTO operation_event (operation_id, version, state, occurred_at) VALUES ('" + OP + "', 1, 'QUEUED', " + STAMP + ")");
        jdbc.update("INSERT INTO operation_command (operation_id, command_text, caller_context, display_context) VALUES ('" + OP + "', 'echo', '', '')");
        jdbc.update("INSERT INTO operation_source (operation_id, plan_digest, source_sha256, source_bytes, cwd, elevation, environment_revision, launcher_command, argv_json,"
            + " caller_context, display_context) VALUES ('" + OP + "', '" + HEX + "', '" + HEX + "', 5, '/tmp', 'NONE', '" + HEX + "', 'python', '[]', '', '')");
        jdbc.update("INSERT INTO operation_upload (operation_id, artifact_id, remote_path, file_name, size_bytes, sha256, overwrite_mode, elevation, upload_protocol)"
            + " VALUES ('" + OP + "', '" + ARTIFACT + "', '/tmp/a', 'a', 1, '" + HEX + "', 'REPLACE', 'NONE', 'UNSPECIFIED')");
        jdbc.update("INSERT INTO operation_download (operation_id, remote_path, elevation, caller_context, display_context) VALUES ('" + OP + "', '/tmp/a', 'NONE', '', '')");
        jdbc.update("INSERT INTO operation_decision (operation_id, decision, reason_code, review_reason, policy_revision, provider, assessed_label, caller_context_provided,"
            + " model_called) VALUES ('" + OP + "', 'EXECUTE', 'COMMAND_SET', 'NONE', 0, 'JEV', 'LOW_RISK', 'YES', 'NO')");
        jdbc.update("INSERT INTO operation_decision_attempt (operation_id, attempt_no, provider, status) VALUES ('" + OP + "', 1, 'JEV', 'UNAVAILABLE')");
        jdbc.update("INSERT INTO operation_decision_command (operation_id, position, command_name) VALUES ('" + OP + "', 1, 'ls')");
        jdbc.update("INSERT INTO operation_result (operation_id, result_kind, result_flag, exec_reason, remote_state, exit_kind, exit_code, signal_delivery, cleanup,"
            + " exec_reconciliation, output_state, capture, stdout_truncated, stderr_truncated, failure_kind, failure_stage, failure_code, failure_remote_outcome, dispatch_kind,"
            + " dispatch_reason, dispatch_stage, evidence_kind, evidence_exit_code, result_texts) VALUES ('" + OP + "', 'EXECUTED', 'OK', 'EXIT', 'EXITED', 'EXITED', 0,"
            + " 'NOT_SENT', 'COMPLETE', 'NOT_REQUIRED', 'COMPLETE', 'OK', 'COMPLETE', 'COMPLETE', 'CLASSIFIED', 'SSH_CONNECT', 'SSH_CONNECT_FAILED', 'NOT_STARTED', NULL, NULL,"
            + " NULL, 'COMMAND_EXITED', 0, '[]')");
        jdbc.update("INSERT INTO operation_slot (scope, slot_no, operation_id) VALUES ('GLOBAL', 1, '" + OP + "')");
        jdbc.update("INSERT INTO operation_fence (target_id, target_revision, conflict_digest, operation_id) VALUES ('alpha', '" + HEX + "', '" + HEX + "', '" + OP + "')");
        jdbc.update("INSERT INTO artifact (id, direction, purpose, state, file_name, size_bytes, received_bytes, chunk_count, file_target_binding, upload_protocol,"
            + " overwrite_mode, elevation, retention, expires_at, version, created_at, consume_reason) VALUES ('" + ARTIFACT + "', 'UPLOAD', 'TRANSFER', 'READY', 'a', 1, 1, 1,"
            + " 'UNBOUND', 'UNSPECIFIED', 'REPLACE', 'NONE', 'PINNED', " + STAMP + ", 1, " + STAMP + ", 'MOVED')");
        jdbc.update("INSERT INTO artifact_chunk (artifact_id, chunk_no, size_bytes, sha256) VALUES ('" + ARTIFACT + "', 1, 1, '" + HEX + "')");
        jdbc.update("INSERT INTO staged_action (artifact_id, operation_key, request_key, input_digest, request_id, action, state, target_id, target_revision, remote_path,"
            + " overwrite_mode, elevation) VALUES ('" + ARTIFACT + "', 'operation-key-00001', 'request-key-000001', '" + HEX + "', '" + OP + "', 'COPY', 'RESERVED', 'alpha', '" + HEX
            + "', '/tmp/a', 'REPLACE', 'NONE')");
        jdbc.update("INSERT INTO command_output (id, execution_id, state, expires_at, charge_bytes, stream_state, stream_truncated, version) VALUES ('" + OUTPUT + "', '" + OP
            + "', 'PENDING', " + STAMP + ", 1, 'OPEN', 'COMPLETE', 1)");
        jdbc.update("INSERT INTO command_output_format (output_id, format, offset_bytes, size_bytes, sha256) VALUES ('" + OUTPUT + "', 'JSON', 0, 1, '" + HEX + "')");
        jdbc.update("INSERT INTO command_policy_rule (target_id, target_revision, profile, os, external_disclosure, model_execution, automatic_uploads, automatic_downloads,"
            + " automatic_sudo, test_server, source_contract, fallback) VALUES ('alpha', '" + HEX + "', 'default', 'LINUX', 'ON', 'ON', 'OFF', 'OFF', 'OFF', 'OFF', 'NONE', 'NONE')");
        jdbc.update("INSERT INTO command_policy_name (target_id, list_kind, position, command_name) VALUES ('alpha', 'ALLOWED', 1, 'ls')");
        jdbc.update("INSERT INTO command_policy_threshold (target_id, provider, model, question_version, basis, min_low_risk, validation_ref) VALUES ('alpha', 'JEV',"
            + " 'jev-1.14.0', 'V5', 'SAFETY_PROBABILITY_V1', 0.9, 'ref')");
        jdbc.update("INSERT INTO agent_cli_request (operation_id, provider, action, package_name, release_version, release_tarball, release_integrity, release_digest,"
            + " expected_installation_revision, intent_digest, plan_expires_at, remote_state, remote_error) VALUES ('" + OP + "', 'CODEX', 'INSTALL', 'p', '1.0.0', 'https://x', 'sha512-x',"
            + " 'sha256:" + HEX + "', '" + HEX + "', 'sha256:" + HEX + "', " + STAMP + ", 'FAILED', 'INSTALL_FAILED')");
    }

    /** One enum column of the fixture: the table and the column. */
    record Column(String table, String column) {
    }

    static Stream<Column> enumColumns() {
        return Stream.of(new Column("operation", "kind"), new Column("operation", "state"), new Column("operation", "approval_mode"),
            new Column("operation", "outcome_certainty"), new Column("operation", "reconciliation"), new Column("operation", "recovery_reason"),
            new Column("operation", "audit_failure"), new Column("operation_event", "state"), new Column("operation_source", "elevation"),
            new Column("operation_upload", "overwrite_mode"), new Column("operation_upload", "elevation"), new Column("operation_upload", "upload_protocol"),
            new Column("operation_download", "elevation"), new Column("operation_decision", "decision"), new Column("operation_decision", "reason_code"),
            new Column("operation_decision", "review_reason"), new Column("operation_decision", "provider"), new Column("operation_decision", "assessed_label"),
            new Column("operation_decision", "caller_context_provided"), new Column("operation_decision", "model_called"),
            new Column("operation_decision_attempt", "provider"), new Column("operation_decision_attempt", "status"), new Column("operation_result", "result_kind"),
            new Column("operation_result", "result_flag"), new Column("operation_result", "exec_reason"), new Column("operation_result", "remote_state"),
            new Column("operation_result", "exit_kind"), new Column("operation_result", "signal_delivery"), new Column("operation_result", "cleanup"),
            new Column("operation_result", "exec_reconciliation"), new Column("operation_result", "output_state"), new Column("operation_result", "capture"),
            new Column("operation_result", "stdout_truncated"), new Column("operation_result", "stderr_truncated"), new Column("operation_result", "failure_kind"),
            new Column("operation_result", "failure_stage"), new Column("operation_result", "failure_code"), new Column("operation_result", "failure_remote_outcome"),
            new Column("operation_result", "evidence_kind"), new Column("artifact", "direction"), new Column("artifact", "purpose"), new Column("artifact", "state"),
            new Column("artifact", "file_target_binding"), new Column("artifact", "upload_protocol"), new Column("artifact", "overwrite_mode"),
            new Column("artifact", "elevation"), new Column("artifact", "retention"), new Column("artifact", "consume_reason"), new Column("staged_action", "action"),
            new Column("staged_action", "state"), new Column("staged_action", "overwrite_mode"), new Column("staged_action", "elevation"),
            new Column("command_output", "state"), new Column("command_output", "stream_state"), new Column("command_output", "stream_truncated"),
            new Column("command_output_format", "format"), new Column("command_policy_rule", "os"), new Column("command_policy_rule", "external_disclosure"),
            new Column("command_policy_rule", "model_execution"), new Column("command_policy_rule", "automatic_uploads"),
            new Column("command_policy_rule", "automatic_downloads"), new Column("command_policy_rule", "automatic_sudo"), new Column("command_policy_rule", "test_server"),
            new Column("command_policy_rule", "source_contract"), new Column("command_policy_rule", "fallback"), new Column("command_policy_name", "list_kind"),
            new Column("command_policy_threshold", "provider"), new Column("command_policy_threshold", "question_version"), new Column("command_policy_threshold", "basis"),
            new Column("agent_cli_request", "provider"), new Column("agent_cli_request", "action"), new Column("agent_cli_request", "remote_state"),
            new Column("agent_cli_request", "remote_error"));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("enumColumns")
    @DisplayName("S2-DB-02: a value that is in no list is refused by the CHECK of every enum column, and the value of the fixture is accepted")
    void everyEnumColumnRefusesAnUnknownValue(Column column) {
        assertThat(jdbc.update("UPDATE " + column.table() + " SET " + column.column() + " = " + column.column())).isGreaterThanOrEqualTo(1);
        assertThatThrownBy(() -> jdbc.update("UPDATE " + column.table() + " SET " + column.column() + " = 'X'")).as(column.toString())
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    @DisplayName("S2-DB-02: every constant of the domain enums that map to a column is accepted by that column's CHECK")
    void everyDomainConstantIsAccepted() {
        // An agent CLI operation must hold the digest of its intent (ck_operation_input_digest), so that kind is accepted together with it.
        acceptAll("operation", "kind", Stream.of(OperationKind.values()).filter(kind -> kind != OperationKind.AGENT_CLI).map(Enum::name).toList());
        assertThat(jdbc.update("UPDATE operation SET kind = 'AGENT_CLI', input_digest = '" + HEX + "'")).isEqualTo(1);
        assertThat(jdbc.update("UPDATE operation SET kind = 'COMMAND', input_digest = NULL")).isEqualTo(1);
        acceptAll("operation", "approval_mode", Stream.of(ApprovalMode.values()).map(Enum::name).toList());
        acceptAll("operation", "outcome_certainty", Stream.of(OutcomeCertainty.values()).map(Enum::name).toList());
        acceptAll("operation", "recovery_reason", Stream.of(RecoveryReason.values()).map(Enum::name).toList());
        acceptAll("operation_event", "state", Stream.of(OperationState.values()).map(Enum::name).toList());
        acceptAll("operation_decision", "decision", Stream.of(DecisionKind.values()).map(Enum::name).toList());
        acceptAll("operation_decision", "reason_code", Stream.of(DecisionReason.values()).map(Enum::name).toList());
        acceptAll("operation_result", "exec_reason", Stream.of(ExecutionReason.values()).map(Enum::name).toList());
        acceptAll("operation_result", "remote_state", Stream.of(RemoteState.values()).map(Enum::name).toList());
    }

    @Test
    @DisplayName("S2-DB-02: the dispatch reasons and stages of the domain are accepted by the columns of a refused result")
    void dispatchReasonsAndStagesAreAccepted() {
        jdbc.update("DELETE FROM operation_result");
        for (DispatchReason reason : DispatchReason.values()) {
            for (DispatchStage stage : DispatchStage.values()) {
                jdbc.update("INSERT INTO operation_result (operation_id, result_kind, result_flag, exit_kind, failure_kind, dispatch_kind, dispatch_reason, dispatch_stage,"
                    + " evidence_kind, result_texts) VALUES ('" + OP + "', 'REFUSED', 'FAILED', 'NO_EXIT', 'NONE', 'REFUSED', '" + reason.name() + "', '" + stage.name()
                    + "', 'NO_EVIDENCE', '[]')");
                jdbc.update("DELETE FROM operation_result");
            }
        }
    }

    @Test
    @DisplayName("S2-DB-02: ranges and shapes are enforced: a version below 1, a slot number below 1, a size over 64 MiB, a policy id other than 1")
    void rangesAndShapesAreEnforced() {
        assertThatThrownBy(() -> jdbc.update("UPDATE operation SET version = 0")).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE operation_slot SET slot_no = 0")).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE artifact SET size_bytes = 67108865")).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE artifact_chunk SET size_bytes = 262145")).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE command_policy SET id = 2")).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE command_policy_threshold SET min_low_risk = 0.5")).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE operation_result SET exit_kind = 'SIGNALED'")).as("a signal exit needs a signal name").isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE operation SET input_digest = '" + HEX + "'")).as("only an agent CLI operation has an input digest")
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    @DisplayName("S2-DB-02: keys are enforced: a second operation with the same request key, a second row for one slot, a child without its parent")
    void keysAreEnforced() {
        assertThatThrownBy(() -> jdbc.update("INSERT INTO operation (id, request_key, owner_id, target_id, target_revision, kind, state, version, approval_mode, profile,"
            + " contract_digest, created_at, updated_at, recovery_reason, audit_failure) VALUES ('" + "d".repeat(48) + "', 'request-key-000001', 'o', 'alpha', '" + HEX
            + "', 'COMMAND', 'ACCEPTED', 1, 'NOT_DECIDED', 'default', '" + HEX + "', " + STAMP + ", " + STAMP + ", 'NONE', 'NONE')")).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("INSERT INTO operation_slot (scope, slot_no, operation_id) VALUES ('GLOBAL', 1, '" + OP + "')"))
            .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("INSERT INTO operation_command (operation_id, command_text, caller_context, display_context) VALUES ('" + "e".repeat(48)
            + "', 'x', '', '')")).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("INSERT INTO operation_fence (target_id, target_revision, conflict_digest, operation_id) VALUES ('alpha', '" + HEX + "', '" + HEX
            + "', '" + OP + "')")).as("a conflict key is held by one operation").isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("DELETE FROM operation")).as("an operation with rows below it cannot be deleted").isInstanceOf(DataIntegrityViolationException.class);
    }

    private void acceptAll(String table, String column, List<String> values) {
        for (String value : values) {
            // The row is read back after the change, so that the statement is a write that the CHECK has judged, not a statement that matched no row.
            assertThat(jdbc.update("UPDATE " + table + " SET " + column + " = '" + value + "'")).as(table + "." + column + " = " + value).isGreaterThanOrEqualTo(1);
        }
        jdbc.update("UPDATE " + table + " SET " + column + " = " + column);
    }
}
