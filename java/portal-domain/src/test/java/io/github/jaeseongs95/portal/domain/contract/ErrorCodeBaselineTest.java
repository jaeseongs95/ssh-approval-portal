package io.github.jaeseongs95.portal.domain.contract;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * S2-CO-01 (stage 2 design 5.3): the eight error code enums against the contract baseline {@code contract/mcp/envelope.schema.json} ({@code x-portal-errorCodes}).
 * The baseline lists every UPPER_SNAKE literal 2.x raises. Four groups are not codes of the public contract and are named here with their reason; one code is new.
 */
class ErrorCodeBaselineTest {

    /** 2.x storage and Node internals: SQLite file opening, schema versions, transaction poisoning (they become Flyway and JDBC transactions). */
    private static final Set<String> GONE = Set.of("INVALID_OPERATION_BUDGET", "OPERATION_PATH", "OPERATION_TRANSACTION_UNCERTAIN", "UNSAFE_CAPACITY_STORE",
        "UNSAFE_OPERATION_STORE", "UNSUPPORTED_OPERATION_SCHEMA");

    /** Pieces of a code that 2.x assembles as {@code INVALID_${name}}; the finished codes are not literals. */
    private static final Set<String> FRAGMENTS = Set.of("OPERATION_ID", "LEGACY_SOURCE");

    /** Owned by the migration module (the offline read of a 2.x store), not part of the public contract. */
    private static final Set<String> MIGRATION = Set.of("UNSAFE_LEGACY_FILE", "LEGACY_NOT_QUIESCENT", "UNSUPPORTED_LEGACY_SCHEMA", "LEGACY_HISTORY_CAPACITY",
        "INVALID_LEGACY_HISTORY", "INVALID_LEGACY_REQUEST_KEY", "LEGACY_ENTRY_TOO_LARGE", "UNSAFE_LEGACY_ROOT", "LEGACY_CHANGED_DURING_READ", "INVALID_MIGRATION_TARGET",
        "UNSAFE_LEGACY_ARCHIVE", "LEGACY_ARCHIVE_MISMATCH", "LEGACY_CHANGED_DURING_IMPORT", "INVALID_LEGACY_IMPORT_BASELINE", "LEGACY_MIGRATION_RECORD_MISSING",
        "INVALID_LEGACY_BATCH");

    /** The wire codes inside the desktop module (server to the xfreerdp input helper); they are not in the public envelope. */
    private static final Set<String> DESKTOP_WIRE = Set.of("WIRE_LIMIT", "TRANSPORT_CLOSED", "TRANSPORT_FAILED", "ACK_TIMEOUT", "INVALID_FRAME", "CAPABILITY_MISMATCH",
        "INPUT_BUSY", "INVALID_ACK", "PARTIAL_OR_UNKNOWN");

    /** The eleven codes the baseline's grep missed (decision D-19); they are listed in the baseline's {@code stage2Additions}. */
    private static final Set<String> D19 = Set.of("COMMAND_CONTEXT_CONTAINS_SECRET", "COMMAND_CONTEXT_TOO_LARGE", "INVALID_COMMAND_CONTEXT", "READ_COMMAND_BUSY",
        "READ_COMMAND_EXECUTION_UNKNOWN", "READ_COMMAND_NOT_STARTED", "READ_COMMAND_REQUIRES_APPROVAL", "SOURCE_ARGUMENTS_SENSITIVE", "SOURCE_CREDENTIAL_MATERIAL",
        "SOURCE_WORKDIR_SENSITIVE", "DESKTOP_AUTH_BROKER_UNAVAILABLE");

    private final JsonMapper mapper = JsonMapper.builder().build();

    @Test
    @DisplayName("S2-CO-01 every constant of every category is a valid wire code and no code is in two categories")
    void everyConstantIsAWireCodeOnce() {
        List<String> names = allNames();
        assertThat(names).isNotEmpty().doesNotHaveDuplicates();
        for (String name : names) {
            assertThat(ErrorData.CODE_PATTERN.matcher(name).matches()).as(name).isTrue();
        }
    }

    @Test
    @DisplayName("S2-CO-01 the categories hold the counted number of codes: 30, 23, 46, 9, 13, 72, 18 and 7")
    void categoriesHoldTheCountedCodes() {
        assertThat(RequestErrorCode.values()).hasSize(30);
        assertThat(OperationErrorCode.values()).hasSize(23);
        assertThat(ArtifactErrorCode.values()).hasSize(46);
        assertThat(HistoryErrorCode.values()).hasSize(9);
        assertThat(CapacityErrorCode.values()).hasSize(13);
        assertThat(DesktopErrorCode.values()).hasSize(72);
        assertThat(TransferErrorCode.values()).hasSize(18);
        assertThat(ExecutionErrorCode.values()).hasSize(7);
        assertThat(allNames()).hasSize(218);
    }

    @Test
    @DisplayName("S2-CO-01 the union of the eight enums is the baseline codes, less the four groups that are not public codes, plus REQUEST_CAPACITY_EXCEEDED (D-07)")
    void unionIsTheBaselineMinusNonCodesPlusTheNewCode() {
        Set<String> expected = new TreeSet<>(baselineCodes());
        expected.removeAll(GONE);
        expected.removeAll(FRAGMENTS);
        expected.removeAll(MIGRATION);
        expected.removeAll(DESKTOP_WIRE);
        expected.add("REQUEST_CAPACITY_EXCEEDED");
        assertThat(new TreeSet<>(allNames())).isEqualTo(expected);
        assertThat(baselineCodes()).doesNotContain("REQUEST_CAPACITY_EXCEEDED");
    }

    @Test
    @DisplayName("S2-CO-01 the eleven codes of decision D-19 are in the baseline and in an enum")
    void theElevenAddedCodesAreInTheBaselineAndTheEnums() {
        JsonNode additions = readBaseline().path("x-portal-errorCodes").path("stage2Additions").path("entries");
        List<String> listed = new ArrayList<>();
        for (JsonNode entry : additions) {
            listed.add(entry.get(0).stringValue());
            assertThat(entry.get(1).stringValue()).startsWith("src/");
        }
        assertThat(listed).containsExactlyInAnyOrderElementsOf(D19);
        assertThat(allNames()).containsAll(D19);
    }

    @Test
    @DisplayName("S2-CO-01 the 24 message-to-code rows of 2.x answer with a code that exists (the mapping itself is gone: every throw site owns its code)")
    void everyTransferRefusalRowAnswersWithAKnownCode() {
        JsonNode rows = readBaseline().path("x-portal-errorCodes").path("confirmedPublicContract").path("transferRefusals").path("entries");
        assertThat(rows).hasSize(24);
        for (JsonNode row : rows) {
            assertThat(allNames()).as(row.get(0).stringValue()).contains(row.get(1).stringValue());
        }
    }

    private List<String> allNames() {
        List<ErrorCode> codes = new ArrayList<>();
        Collections.addAll(codes, RequestErrorCode.values());
        Collections.addAll(codes, OperationErrorCode.values());
        Collections.addAll(codes, ArtifactErrorCode.values());
        Collections.addAll(codes, HistoryErrorCode.values());
        Collections.addAll(codes, CapacityErrorCode.values());
        Collections.addAll(codes, DesktopErrorCode.values());
        Collections.addAll(codes, TransferErrorCode.values());
        Collections.addAll(codes, ExecutionErrorCode.values());
        return codes.stream().map(ErrorCode::name).toList();
    }

    private Set<String> baselineCodes() {
        JsonNode block = readBaseline().path("x-portal-errorCodes");
        Set<String> codes = new TreeSet<>();
        JsonNode confirmed = block.path("confirmedPublicContract");
        collectFirst(confirmed.path("failureCalls"), codes);
        collectFirst(confirmed.path("fallback"), codes);
        for (JsonNode row : confirmed.path("transferRefusals").path("entries")) {
            codes.add(row.get(1).stringValue());
        }
        JsonNode server = block.path("serverLayerCandidates");
        for (String group : server.propertyNames()) {
            JsonNode value = server.path(group);
            if (value.isArray()) {
                collectFirst(value, codes);
            } else if (value.has("entries")) {
                collectFirst(value.path("entries"), codes);
            }
        }
        collectFirst(block.path("stage2Additions").path("entries"), codes);
        return codes;
    }

    private void collectFirst(JsonNode entries, Set<String> into) {
        for (JsonNode entry : entries) {
            into.add(entry.get(0).stringValue());
        }
    }

    private JsonNode readBaseline() {
        try (InputStream in = ErrorCodeBaselineTest.class.getClassLoader().getResourceAsStream("contract/mcp/envelope.schema.json")) {
            assertThat(in).as("the baseline is on the test classpath (portal-domain/build.gradle.kts adds portal-web's test resources)").isNotNull();
            return mapper.readTree(in);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
