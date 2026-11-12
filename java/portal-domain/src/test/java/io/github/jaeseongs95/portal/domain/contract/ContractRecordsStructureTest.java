package io.github.jaeseongs95.portal.domain.contract;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.domain.error.ExecutionAttempt;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Cases S2-CO-02 and S2-CO-03 of docs/migration/stage2-design.md (5.1, 5.2, 5.4): the contract records, written by Jackson 3, have the structure the 2.x baseline
 * (contract/mcp/tools/*.json {@code outputSchema} and contract/mcp/envelope.schema.json) pins: the key set, the required keys, {@code additionalProperties: false},
 * the enum vocabularies, the string patterns and the integer ranges; null fields are written. The baseline files are read from the test class path.
 *
 * <p>The helper that reads the baseline is a small JSON Schema subset (the keywords the baseline uses: {@code $ref} into {@code $defs}, {@code anyOf},
 * {@code const}, {@code enum}, {@code type}, {@code properties}, {@code required}, {@code additionalProperties}, {@code items}, {@code pattern}, the length and
 * range keywords). The {@code if/then/else} of the envelope schema is not evaluated: the ok/data/error relation is asserted directly.
 */
class ContractRecordsStructureTest {

    private static final long NOW = 1_700_000_000_000L;
    private static final String ID = "a".repeat(48);
    private static final String OTHER_ID = "e".repeat(48);
    private static final String DIGEST = "b".repeat(64);
    private static final String OTHER_DIGEST = "c".repeat(64);
    private static final String KEY = "operation-key-0001";
    private static final String TARGET = "linux-1";
    private static final String UUID_TEXT = "123e4567-e89b-42d3-a456-426614174000";
    private static final String OPEN_KEY = "c".repeat(32) + "_12_" + "d".repeat(32) + "_" + "E".repeat(43);

    private final JsonMapper mapper = JsonMapper.builder().build();

    // ---------------------------------------------------------------------------------------------------------------------------------------------------------
    // S2-CO-02: structure of every record against the baseline
    // ---------------------------------------------------------------------------------------------------------------------------------------------------------

    @Test
    @DisplayName("S2-CO-02 targets: TargetsData has the baseline keys, required keys and vocabularies; an absent gui and openRequest are left out")
    void targetsDataMatchesTheBaseline() {
        assertToolConforms("targets", fullTargets(), true);

        TargetsData minimal = new TargetsData(List.of(new TargetData(TARGET, "Linux one", false, false, null, PlatformWire.WINDOWS,
            new TargetCapabilitiesData(CommandShellWire.WINDOWS_POWERSHELL_5_1, false, false, false, false, false, false), null, null)), null,
            new LimitsData(1L, 2L, 3L, 4L, 5L, 6L), ApprovalData.of("https://portal.example.test/"));
        assertToolConforms("targets", minimal, false);
        JsonNode target = wire(minimal).path("targets").get(0);
        assertThat(target.has("gui")).as("a null gui is left out, not written as null").isFalse();
        assertThat(target.has("filePolicy")).as("a null filePolicy is written").isTrue();
        assertThat(target.path("filePolicy").isNull()).isTrue();
        assertThat(target.path("revision").isNull()).isTrue();
        assertThat(wire(minimal).path("defaultTarget").isNull()).isTrue();

        GuiDescriptor withoutOpenRequest = new GuiDescriptor(false, null, null, GuiStatusWire.DISABLED, null, List.of(), false, null);
        JsonNode descriptor = wire(withoutOpenRequest);
        assertThat(descriptor.has("openRequest")).as("a null openRequest is left out").isFalse();
        assertThat(descriptor.path("backend").isNull()).isTrue();
        assertThat(descriptor.path("reason").isNull()).isTrue();
    }

    @Test
    @DisplayName("S2-CO-02 submit, observe, cancel, artifact-finish: OperationData has the baseline keys, all null fields written, and a null streamPage")
    void operationDataMatchesTheBaseline() {
        for (String tool : List.of("submit", "observe", "cancel", "artifact-finish")) {
            assertToolConforms(tool, fullOperation(), true);
            assertToolConforms(tool, minimalOperation(), true);
        }
        JsonNode minimal = wire(minimalOperation());
        assertThat(minimal.propertyNames()).hasSize(23);
        assertThat(minimal.path("streamPage").isNull()).isTrue();
        assertThat(minimal.path("execution").isNull()).isTrue();
        assertThat(minimal.has("operationKey")).isTrue();
        assertThat(minimal.path("operationKey").isNull()).isTrue();
        assertThat(minimal.path("state").stringValue()).isEqualTo("accepted");
    }

    @Test
    @DisplayName("S2-CO-02 ExecutionData: every component is nullable and all 14 keys are written, null included")
    void executionDataWritesAllKeysWithNulls() {
        JsonNode allNull = wire(new ExecutionData(null, null, null, null, null, null, null, null, null, null, null, null, null, null));
        assertThat(allNull.propertyNames()).containsExactlyInAnyOrder("phase", "reason", "remoteState", "exitCode", "signal", "automaticReplay", "signalDelivery",
            "timeoutMs", "cleanupComplete", "requiresReconciliation", "outputState", "captureFailed", "stdout", "stderr");
        for (JsonNode value : allNull.values()) {
            assertThat(value.isNull()).isTrue();
        }
        JsonNode exitedByNegative = wire(new ExecutionData(ExecutionPhaseWire.SETTLED, ExecutionReasonWire.DEADLINE, RemoteStateWire.UNKNOWN, -1L, null, Boolean.FALSE,
            null, 60_000L, null, null, null, null, null, null));
        assertThat(exitedByNegative.path("exitCode").longValue()).isEqualTo(-1L);
        assertThat(exitedByNegative.path("automaticReplay").booleanValue()).isFalse();
        assertThat(exitedByNegative.path("reason").stringValue()).isEqualTo("deadline");
    }

    @Test
    @DisplayName("S2-CO-02 files: FilesData and StagedFile have the baseline keys; a stat has a null request")
    void filesDataMatchesTheBaseline() {
        assertToolConforms("files", new FilesData(FilesActionWire.COPY, UUID_TEXT, stagedFile(), fullOperation()), true);
        FilesData stat = new FilesData(FilesActionWire.STAT, UUID_TEXT, stagedFile(), null);
        assertToolConforms("files", stat, false);
        assertThat(wire(stat).has("request")).isTrue();
        assertThat(wire(stat).path("request").isNull()).isTrue();
        assertThat(wire(stat).path("file").path("operations").size()).isEqualTo(2);
    }

    @Test
    @DisplayName("S2-CO-02 artifact-begin, artifact-chunk, artifact-status, artifact-read: the transfer records have the baseline keys")
    void transferRecordsMatchTheBaseline() {
        TransferData transfer = new TransferData(ID, 5L, 1L, 1024L, DIGEST, NOW, TARGET, OTHER_DIGEST);
        assertToolConforms("artifact-begin", BeginData.of(transfer), true);
        assertThat(wire(BeginData.of(transfer)).path("maxChunkBytes").longValue()).isEqualTo(262_144L);
        assertToolConforms("artifact-chunk", new ChunkData(1L, 5L), true);
        assertToolConforms("artifact-status", new TransferStatus(TransferStateWire.READY, transfer, fullOperation()), true);
        assertToolConforms("artifact-status", new TransferStatus(TransferStateWire.STAGING, transfer, null), false);
        assertToolConforms("artifact-status", new TransferStatus(TransferStateWire.SUBMITTED, null, fullOperation()), false);
        JsonNode submitted = wire(new TransferStatus(TransferStateWire.SUBMITTED, null, fullOperation()));
        assertThat(submitted.has("transfer")).isTrue();
        assertThat(submitted.path("transfer").isNull()).isTrue();
        assertToolConforms("artifact-read", new ArtifactPage(ID, OTHER_ID, "out.bin", "base64", "aGVsbG8=", 0L, 5L, 5L, 5L, DIGEST, true, NOW), true);
    }

    @Test
    @DisplayName("S2-CO-02 desktop-open, desktop-status: SessionData has the baseline keys; the optional keys are left out when null")
    void sessionDataMatchesTheBaseline() {
        assertToolConforms("desktop-open", fullSession(), true);
        assertToolConforms("desktop-status", fullSession(), true);

        SessionData minimal = new SessionData(UUID_TEXT, 1L, TARGET, DIGEST, 1L, 2L, "desktop", null, null, null, null, null);
        assertToolConforms("desktop-open", minimal, false);
        JsonNode wire = wire(minimal);
        assertThat(wire.propertyNames()).containsExactlyInAnyOrder("sessionId", "epoch", "targetId", "targetRevision", "expiresAt", "idleExpiresAt", "kind",
            "lastInputReceipt");
        assertThat(wire.path("lastInputReceipt").isNull()).as("the baseline allows an explicit null here").isTrue();

        JsonNode readiness = wire(readiness());
        assertThat(readiness.path("sessionRef").stringValue()).isEqualTo("session.ref:1");
        DesktopReadinessData unset = new DesktopReadinessData(DesktopReadinessStateWire.TRANSPORT_READY, 0L, null, null, null, null, null, false, false, false, false,
            false, List.of());
        JsonNode unsetWire = wire(unset);
        assertThat(unsetWire.propertyNames()).hasSize(13);
        assertThat(unsetWire.path("sessionRef").isNull()).as("optional and nullable: written as null").isTrue();
        assertThat(unsetWire.path("resourceGeneration").isNull()).isTrue();
        assertThat(unsetWire.path("blockers").isArray()).isTrue();
    }

    @Test
    @DisplayName("S2-CO-02 desktop-observe: FrameData has the baseline keys, the session keys flat on the same object")
    void frameDataMatchesTheBaseline() {
        assertToolConforms("desktop-observe", fullFrame(), true);
        FrameData minimal = new FrameData(UUID_TEXT, 1L, TARGET, DIGEST, 1L, 2L, "desktop", null, null, null, 1L, null, "frame-1", 640L, 480L, 1L, "physical-pixels",
            "image/png", 1L);
        assertToolConforms("desktop-observe", minimal, false);
        assertThat(wire(minimal).has("readiness")).isFalse();
        assertThat(wire(minimal).path("nextInputSequence").longValue()).isEqualTo(1L);
    }

    @Test
    @DisplayName("S2-CO-02 desktop-input, desktop-close: InputReceipt and CloseData have the baseline keys")
    void inputReceiptAndCloseDataMatchTheBaseline() {
        assertToolConforms("desktop-input", new InputReceipt(UUID_TEXT, 2L, "input-1", "sent"), true);
        assertToolConforms("desktop-close", new CloseData(UUID_TEXT, true, true, false, DesktopSessionStateWire.PRESERVED, "release failed"), true);
        CloseData withoutState = new CloseData(UUID_TEXT, true, false, false, null, null);
        assertToolConforms("desktop-close", withoutState, false);
        JsonNode wire = wire(withoutState);
        assertThat(wire.has("sessionState")).as("a null sessionState is left out").isFalse();
        assertThat(wire.has("cleanupError")).isTrue();
        assertThat(wire.path("cleanupError").isNull()).isTrue();
        assertThat(wire.path("logout").booleanValue()).isFalse();
    }

    @Test
    @DisplayName("S2-CO-02 DesktopCapabilitiesData leaves out an ability that was not set")
    void desktopCapabilitiesLeaveOutUnsetAbilities() {
        JsonNode wire = wire(new DesktopCapabilitiesData(null, Boolean.TRUE, null, Boolean.FALSE));
        assertThat(wire.propertyNames()).containsExactlyInAnyOrder("pointer", "text");
        assertThat(wire(new DesktopCapabilitiesData(null, null, null, null)).propertyNames()).isEmpty();
    }

    @Test
    @DisplayName("S2-CO-02 each wire enum has exactly the values of the baseline enum it stands for")
    void wireEnumsHaveTheBaselineVocabulary() {
        assertVocabulary("submit", OperationKindWire.class, "operationData", "kind");
        assertVocabulary("submit", OperationState.class, "operationData", "state");
        assertVocabulary("observe", OperationState.class, "operationData", "state");
        assertVocabulary("cancel", OperationState.class, "operationData", "state");
        assertVocabulary("artifact-finish", OperationState.class, "operationData", "state");
        assertVocabulary("submit", ApprovalModeWire.class, "operationData", "approvalMode");
        assertVocabulary("submit", RemoteOutcomeWire.class, "operationData", "remoteOutcome");
        assertVocabulary("submit", RemoteCleanupWire.class, "operationData", "remoteCleanup");
        assertVocabulary("submit", DiagnosticOriginWire.class, "operationData", "diagnostic", "origin");
        assertVocabulary("submit", OutputReferenceStateWire.class, "operationData", "output", "state");
        assertVocabulary("submit", ExecutionPhaseWire.class, "executionData", "phase");
        assertVocabulary("submit", ExecutionReasonWire.class, "executionData", "reason");
        assertVocabulary("submit", RemoteStateWire.class, "executionData", "remoteState");
        assertVocabulary("submit", SignalDeliveryWire.class, "executionData", "signalDelivery");
        assertVocabulary("submit", OutputStateWire.class, "executionData", "outputState");
        assertVocabulary("targets", PlatformWire.class, "targetData", "targets", "[]", "platform");
        assertVocabulary("targets", CommandShellWire.class, "targetData", "targets", "[]", "capabilities", "commandShell");
        assertVocabulary("targets", FileAccessModeWire.class, "targetData", "targets", "[]", "filePolicy", "mode");
        assertVocabulary("targets", GuiBackendWire.class, "targetData", "targets", "[]", "gui", "backend");
        assertVocabulary("targets", GuiLifecycleWire.class, "targetData", "targets", "[]", "gui", "lifecycle");
        assertVocabulary("targets", GuiStatusWire.class, "targetData", "targets", "[]", "gui", "status");
        assertVocabulary("targets", GuiActionWire.class, "targetData", "targets", "[]", "gui", "actions", "[]");
        assertVocabulary("files", FilesActionWire.class, "filesData", "action");
        assertVocabulary("files", StagedFileStateWire.class, "filesData", "file", "state");
        assertVocabulary("files", FilePlacementWire.class, "filesData", "file", "operations", "[]", "action");
        assertVocabulary("files", StagedOperationStateWire.class, "filesData", "file", "operations", "[]", "state");
        assertVocabulary("artifact-status", TransferStateWire.class, "transferStatus", "state");
        assertVocabulary("desktop-open", GuiLifecycleWire.class, "sessionData", "lifecycle");
        assertVocabulary("desktop-open", DesktopReadinessStateWire.class, "sessionData", "readiness", "state");
        assertVocabulary("desktop-open", DesktopBlockerWire.class, "sessionData", "readiness", "blockers", "[]");
        assertVocabulary("desktop-close", DesktopSessionStateWire.class, "closeData", "sessionState");
    }

    @Test
    @DisplayName("S2-CO-02 the string patterns and integer ranges of the records are the baseline's, as text")
    void formatsAndRangesAreTheBaselines() {
        JsonNode submit = outputSchema("submit");
        assertThat(WireFormat.IDENTIFIER.pattern()).isEqualTo(submit.path("$defs").path("identifier").path("pattern").stringValue());
        assertThat(WireFormat.DIGEST.pattern()).isEqualTo(submit.path("$defs").path("digest").path("pattern").stringValue());
        assertThat(WireFormat.TARGET.pattern()).isEqualTo(submit.path("$defs").path("target").path("pattern").stringValue());
        assertThat(WireFormat.KEY.pattern()).isEqualTo(submit.path("$defs").path("key").path("pattern").stringValue());
        assertThat(WireFormat.SIGNAL.pattern()).isEqualTo(schemaAt(submit, "executionData", "signal").path("pattern").stringValue());
        assertThat(WireFormat.UUID.pattern()).isEqualTo(outputSchema("files").path("$defs").path("uuid").path("pattern").stringValue());
        assertThat(WireFormat.OPEN_REQUEST_KEY.pattern())
            .isEqualTo(schemaAt(outputSchema("targets"), "targetData", "targets", "[]", "gui", "openRequest", "requestKey").path("pattern").stringValue());
        JsonNode desktop = outputSchema("desktop-open");
        assertThat(WireFormat.SESSION_ID.pattern()).isEqualTo(desktop.path("$defs").path("sessionId").path("pattern").stringValue());
        assertThat(WireFormat.SESSION_REF.pattern()).isEqualTo(schemaAt(desktop, "desktopReadiness", "sessionRef").path("pattern").stringValue());

        JsonNode nint = submit.path("$defs").path("nint");
        assertThat(WireNumber.NON_NEGATIVE.min()).isEqualTo(nint.path("minimum").longValue());
        assertThat(WireNumber.NON_NEGATIVE.max()).isEqualTo(nint.path("maximum").longValue());
        JsonNode pint = desktop.path("$defs").path("pint");
        assertThat(WireNumber.POSITIVE.min()).isEqualTo(pint.path("exclusiveMinimum").longValue() + 1L);
        assertThat(WireNumber.POSITIVE.max()).isEqualTo(pint.path("maximum").longValue());
        JsonNode exitCode = schemaAt(submit, "executionData", "exitCode");
        assertThat(WireNumber.SIGNED.min()).isEqualTo(exitCode.path("minimum").longValue());
        assertThat(WireNumber.SIGNED.max()).isEqualTo(exitCode.path("maximum").longValue());
        JsonNode timeout = schemaAt(submit, "executionData", "timeoutMs");
        assertThat(WireNumber.POSITIVE.min()).isEqualTo(timeout.path("exclusiveMinimum").longValue() + 1L);
        assertThat(WireNumber.ARTIFACT_BYTES.max()).isEqualTo(schemaAt(outputSchema("artifact-begin"), "beginData", "size").path("maximum").longValue());
        assertThat(WireNumber.ARTIFACT_BYTES.max()).isEqualTo(schemaAt(outputSchema("artifact-read"), "artifactPage", "totalBytes").path("maximum").longValue());
        assertThat(WireNumber.CHUNK_BYTES.max()).isEqualTo(schemaAt(outputSchema("artifact-read"), "artifactPage", "bytes").path("maximum").longValue());
        assertThat(BeginData.MAX_CHUNK_BYTES).isEqualTo(schemaAt(outputSchema("artifact-begin"), "beginData", "maxChunkBytes").path("const").longValue());
    }

    @Test
    @DisplayName("S2-CO-02 a record refuses a value the baseline would refuse: pattern, range, constant and size")
    void recordsRefuseWhatTheBaselineRefuses() {
        assertThatThrownBy(() -> new ArtifactSummary("x", -1L, DIGEST)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ArtifactSummary("x", 1L, DIGEST.toUpperCase(java.util.Locale.ROOT))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ArtifactSummary("x", 1L, DIGEST + "\n")).as("a final line break is refused").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> operationWith("short", KEY)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> operationWith(ID, KEY + "\n")).as("a key with a final line break").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> operationWith(ID, "short-key")).as("a key shorter than 16").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ExecutionData(null, null, null, null, null, Boolean.TRUE, null, null, null, null, null, null, null, null))
            .as("the portal never replays by itself").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ExecutionData(null, null, null, null, null, null, null, 0L, null, null, null, null, null, null))
            .as("timeoutMs is positive").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ExecutionData(null, null, null, null, "sigterm", null, null, null, null, null, null, null, null, null))
            .as("signal pattern").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new GuiDescriptor(true, null, null, GuiStatusWire.CONFIGURED, null,
            List.of(GuiActionWire.OBSERVE, GuiActionWire.POINTER, GuiActionWire.KEY, GuiActionWire.TEXT, GuiActionWire.OBSERVE), false, null))
            .as("at most 4 actions").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new GuiDescriptor(true, null, null, GuiStatusWire.CONFIGURED, "r".repeat(257), List.of(), false, null))
            .as("reason at most 256").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new GuiDescriptor(true, null, null, GuiStatusWire.CONFIGURED, null, List.of(), true, null))
            .as("requiresUserClient is false").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new FilePolicyData(false, false, FileAccessModeWire.CONFIGURED_ROOT, null, null, true, false, true))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ApprovalData("https://portal.example.test/", true)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ApprovalData.of("/relative/path")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new BeginData(ID, 0L, 0L, 1L, DIGEST, NOW, TARGET, OTHER_DIGEST, 1L)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TransferData(ID, 0L, 0L, 67_108_865L, DIGEST, NOW, TARGET, OTHER_DIGEST)).as("size at most 64 MiB")
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ArtifactPage(ID, ID, "f", "base64", "", 0L, 262_145L, 0L, 0L, DIGEST, true, NOW)).as("a page is at most 256 KiB")
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ArtifactPage(ID, ID, "f", "hex", "", 0L, 0L, 0L, 0L, DIGEST, true, NOW)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new StagedFile("not-a-uuid", StagedFileStateWire.READY, "f", 1L, DIGEST, NOW, 1L, 1L, List.of()))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new StagedFile(UUID_TEXT, StagedFileStateWire.READY, "", 1L, DIGEST, NOW, 1L, 1L, List.of()))
            .as("file name 1 to 255").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new InputReceipt(UUID_TEXT, 0L, "k", "sent")).as("sequence is positive").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new InputReceipt(UUID_TEXT, 1L, "k", "queued")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new SessionData(UUID_TEXT, 1L, TARGET, DIGEST, 1L, 2L, "gui", null, null, null, null, null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new FrameData(UUID_TEXT, 1L, TARGET, DIGEST, 1L, 2L, "desktop", null, null, null, 1L, null, "f", 1L, 1L, 1L, "physical-pixels",
            "image/jpeg", 1L)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new FrameData(UUID_TEXT, 1L, TARGET, DIGEST, 1L, 2L, "desktop", null, null, null, 1L, null, "f".repeat(97), 1L, 1L, 1L,
            "physical-pixels", "image/png", 1L)).as("frame id at most 96").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new CloseData(UUID_TEXT, true, true, true, null, null)).as("logout is false").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new CloseData(UUID_TEXT, false, true, false, null, null)).as("closed is true").isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new OutputReference(2L, OutputReference.CAPTURE_SOURCE, OutputReference.SSH_COMPLETENESS, null, OutputReferenceStateWire.PENDING, null,
            null, null, null)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S2-CO-02 a list component is copied: a change of the caller's list or of the record's list cannot change the record")
    void listComponentsAreCopied() {
        List<GuiActionWire> actions = new ArrayList<>(List.of(GuiActionWire.OBSERVE));
        GuiDescriptor descriptor = new GuiDescriptor(true, null, null, GuiStatusWire.CONFIGURED, null, actions, false, null);
        actions.add(GuiActionWire.POINTER);
        assertThat(descriptor.actions()).containsExactly(GuiActionWire.OBSERVE);
        assertThatThrownBy(() -> descriptor.actions().add(GuiActionWire.KEY)).isInstanceOf(UnsupportedOperationException.class);

        List<DesktopBlockerWire> blockers = new ArrayList<>(List.of(DesktopBlockerWire.DESKTOP_AUTH_REQUIRED));
        DesktopReadinessData readiness = new DesktopReadinessData(DesktopReadinessStateWire.AUTH_REQUIRED, 0L, null, null, null, null, null, false, false, false, false,
            false, blockers);
        blockers.clear();
        assertThat(readiness.blockers()).containsExactly(DesktopBlockerWire.DESKTOP_AUTH_REQUIRED);
        assertThatThrownBy(() -> new DesktopReadinessData(DesktopReadinessStateWire.AUTH_REQUIRED, 0L, null, null, null, null, null, false, false, false, false, false,
            java.util.Collections.nCopies(9, DesktopBlockerWire.DESKTOP_AUTH_REQUIRED))).as("at most 8 blockers").isInstanceOf(IllegalArgumentException.class);
    }

    // ---------------------------------------------------------------------------------------------------------------------------------------------------------
    // S2-CO-03: the envelope
    // ---------------------------------------------------------------------------------------------------------------------------------------------------------

    @Test
    @DisplayName("S2-CO-03 Envelope.success writes contractVersion, ok, data and error, with error null written")
    void successEnvelopeWritesFourFields() {
        JsonNode wire = wire(Envelope.success(new ChunkData(0L, 5L)));
        assertThat(wire.propertyNames()).containsExactlyInAnyOrder("contractVersion", "ok", "data", "error");
        assertThat(wire.path("contractVersion").stringValue()).isEqualTo("2.0");
        assertThat(wire.path("ok").booleanValue()).isTrue();
        assertThat(wire.path("data").isObject()).isTrue();
        assertThat(wire.has("error")).isTrue();
        assertThat(wire.path("error").isNull()).isTrue();
        JsonNode envelope = readResource("contract/mcp/envelope.schema.json");
        assertThat(violations(wire, envelope, envelope, "$", true)).isEmpty();
    }

    @Test
    @DisplayName("S2-CO-03 Envelope.failure writes contractVersion, ok, data and error, with data null written, for every ExecutionAttempt")
    void failureEnvelopeWritesFourFields() {
        JsonNode envelope = readResource("contract/mcp/envelope.schema.json");
        for (ExecutionAttempt attempt : ExecutionAttempt.values()) {
            JsonNode wire = wire(Envelope.failure(new ErrorData(RequestErrorCode.REQUEST_REFUSED, attempt == ExecutionAttempt.NOT_ATTEMPTED, attempt)));
            assertThat(wire.propertyNames()).containsExactlyInAnyOrder("contractVersion", "ok", "data", "error");
            assertThat(wire.path("contractVersion").stringValue()).isEqualTo("2.0");
            assertThat(wire.path("ok").booleanValue()).isFalse();
            assertThat(wire.has("data")).isTrue();
            assertThat(wire.path("data").isNull()).isTrue();
            assertThat(wire.path("error").isObject()).isTrue();
            assertThat(wire.path("error").propertyNames()).containsExactlyInAnyOrder("code", "retryable", "executionAttempted");
            assertThat(wire.path("error").path("code").stringValue()).isEqualTo("REQUEST_REFUSED");
            assertThat(violations(wire, envelope, envelope, "$", true)).as("%s", wire).isEmpty();
            JsonNode toolSchema = outputSchema("artifact-chunk");
            assertThat(violations(wire, toolSchema, toolSchema, "$", true)).as("%s", wire).isEmpty();
        }
        JsonNode notAttempted = wire(Envelope.failure(new ErrorData(RequestErrorCode.REQUEST_REFUSED, false, ExecutionAttempt.NOT_ATTEMPTED)));
        assertThat(notAttempted.path("error").path("executionAttempted").isBoolean()).isTrue();
        assertThat(notAttempted.path("error").path("executionAttempted").booleanValue()).isFalse();
        JsonNode unknown = wire(Envelope.failure(new ErrorData(RequestErrorCode.REQUEST_REFUSED, false, ExecutionAttempt.UNKNOWN)));
        assertThat(unknown.path("error").path("executionAttempted").stringValue()).isEqualTo("unknown");
    }

    @Test
    @DisplayName("S2-CO-03 an envelope that breaks the ok/data/error relation cannot be built")
    void anEnvelopeThatBreaksTheRelationIsRefused() {
        ErrorData error = new ErrorData(RequestErrorCode.REQUEST_REFUSED, false, ExecutionAttempt.NOT_ATTEMPTED);
        ChunkData data = new ChunkData(0L, 0L);
        // ok=true with an error
        assertThatThrownBy(() -> new Envelope.Success<>(ContractVersion.V2_0, true, data, error)).isInstanceOf(IllegalArgumentException.class);
        // ok=false with data (a Failure has no data slot at all: Void; the Success variant is what could carry it)
        assertThatThrownBy(() -> new Envelope.Success<>(ContractVersion.V2_0, false, data, null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Envelope.Success<>(ContractVersion.V2_0, false, data, error)).isInstanceOf(IllegalArgumentException.class);
        // ok=true without data
        assertThatThrownBy(() -> new Envelope.Success<ChunkData>(ContractVersion.V2_0, true, null, null)).isInstanceOf(NullPointerException.class);
        // a failure with ok=true, and a failure without an error
        assertThatThrownBy(() -> new Envelope.Failure<ChunkData>(ContractVersion.V2_0, true, null, error)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Envelope.Failure<ChunkData>(ContractVersion.V2_0, false, null, null)).isInstanceOf(NullPointerException.class);
        // the factories build the two legal shapes
        assertThat(Envelope.success(data).ok()).isTrue();
        assertThat(Envelope.<ChunkData>failure(error).ok()).isFalse();
        assertThat(Envelope.success(data).contractVersion()).isEqualTo(ContractVersion.V2_0);
    }

    // ---------------------------------------------------------------------------------------------------------------------------------------------------------
    // samples
    // ---------------------------------------------------------------------------------------------------------------------------------------------------------

    private TargetsData fullTargets() {
        GuiDescriptor gui = new GuiDescriptor(true, GuiBackendWire.RDP, GuiLifecycleWire.MANAGED, GuiStatusWire.CONFIGURED, "ready",
            List.of(GuiActionWire.OBSERVE, GuiActionWire.POINTER, GuiActionWire.KEY, GuiActionWire.TEXT), false, new GuiOpenRequest(OPEN_KEY, NOW + 300_000L));
        TargetData linux = new TargetData(TARGET, "Linux one", true, true, DIGEST, PlatformWire.LINUX,
            new TargetCapabilitiesData(CommandShellWire.POSIX, true, true, true, true, true, true), gui,
            FilePolicyData.of(false, false, FileAccessModeWire.CONFIGURED_ROOT, "/srv/app", NOW));
        return new TargetsData(List.of(linux), TARGET, new LimitsData(32_768L, 16_384L, 67_108_864L, 262_144L, 16_384L, 60_000L),
            ApprovalData.of("https://portal.example.test/"));
    }

    private OperationData fullOperation() {
        ExecutionData execution = new ExecutionData(ExecutionPhaseWire.SETTLED, ExecutionReasonWire.EXIT, RemoteStateWire.EXITED, 0L, "SIGTERM", Boolean.FALSE,
            SignalDeliveryWire.REQUESTED, 60_000L, Boolean.TRUE, Boolean.FALSE, OutputStateWire.COMPLETE, Boolean.FALSE, new StreamMetadata(10L, 10L, 10L, false),
            new StreamMetadata(0L, 0L, 0L, false));
        return new OperationData(ID, KEY, OperationKindWire.COMMAND, OperationState.COMPLETED, TARGET, DIGEST, ApprovalModeWire.OWNER, NOW, NOW + 600_000L, NOW + 100_000L,
            Boolean.FALSE, false, "SSH_EXECUTION_FAILED", RemoteOutcomeWire.COMPLETED, "/srv/app", new Diagnostic(DiagnosticOriginWire.POLICY, "path_outside_root", "open", 13L),
            RemoteCleanupWire.CONFIRMED, execution, OutputReference.of(ID, OutputReferenceStateWire.READY, 20L, 20L, DIGEST, NOW + 900_000L),
            new ArtifactSummary("out.txt", 20L, DIGEST), new OutputPage("hello\n", 0L, 6L, 6L, 6L, DIGEST, true, NOW + 900_000L), null, false);
    }

    private OperationData minimalOperation() {
        return new OperationData(ID, null, OperationKindWire.DOWNLOAD, OperationState.ACCEPTED, null, null, null, 0L, null, null, null, false, null, null, null, null, null,
            null, null, null, null, null, false);
    }

    private OperationData operationWith(String id, String operationKey) {
        return new OperationData(id, operationKey, OperationKindWire.COMMAND, OperationState.ACCEPTED, null, null, null, 0L, null, null, null, false, null, null, null,
            null, null, null, null, null, null, null, false);
    }

    private StagedFile stagedFile() {
        return new StagedFile(UUID_TEXT, StagedFileStateWire.READY, "a.bin", 1024L, DIGEST, NOW, 1024L, 3L,
            List.of(new StagedOperation(KEY, FilePlacementWire.COPY, ID, StagedOperationStateWire.ADMISSION_UNCONFIRMED),
                new StagedOperation(KEY, FilePlacementWire.MOVE, OTHER_ID, StagedOperationStateWire.COMPLETED)));
    }

    private DesktopReadinessData readiness() {
        return new DesktopReadinessData(DesktopReadinessStateWire.AUTH_REQUIRED, NOW, DIGEST, "session.ref:1", OTHER_DIGEST, 3L, Boolean.FALSE, true, true, false, false,
            true, List.of(DesktopBlockerWire.DESKTOP_AUTH_REQUIRED, DesktopBlockerWire.DESKTOP_CAPTURE_UNAVAILABLE));
    }

    private SessionData fullSession() {
        return new SessionData(UUID_TEXT, 1L, TARGET, DIGEST, NOW, NOW + 1_000L, "desktop", readiness(), new DesktopCapabilitiesData(true, true, true, true),
            GuiLifecycleWire.ATTACHED, 7L, new InputReceipt(UUID_TEXT, 2L, "input-1", "sent"));
    }

    private FrameData fullFrame() {
        return new FrameData(UUID_TEXT, 1L, TARGET, DIGEST, NOW, NOW + 1_000L, "desktop", readiness(), new DesktopCapabilitiesData(true, true, true, true),
            GuiLifecycleWire.MANAGED, 7L, new InputReceipt(UUID_TEXT, 2L, "input-1", "sent"), "frame-1", 1920L, 1080L, 4L, "physical-pixels", "image/png", 1L);
    }

    // ---------------------------------------------------------------------------------------------------------------------------------------------------------
    // helpers: the baseline reader (a small JSON Schema subset) and the wire
    // ---------------------------------------------------------------------------------------------------------------------------------------------------------

    private JsonNode wire(Object value) {
        return mapper.readTree(mapper.writeValueAsString(value));
    }

    private JsonNode readResource(String name) {
        try (InputStream in = getClass().getResourceAsStream("/" + name)) {
            assertThat(in).as("test class path resource %s", name).isNotNull();
            return mapper.readTree(in);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private JsonNode outputSchema(String tool) {
        return readResource("contract/mcp/tools/" + tool + ".json").path("outputSchema");
    }

    /** The envelope of a successful answer with this data must satisfy the tool's baseline outputSchema; {@code exact} also demands every declared key. */
    private void assertToolConforms(String tool, Object data, boolean exact) {
        JsonNode schema = outputSchema(tool);
        JsonNode wire = wire(Envelope.success(data));
        assertThat(violations(wire, schema, schema, "$", exact)).as("%s: %s", tool, wire).isEmpty();
    }

    /** The wire values of the enum are the values of the baseline enum at {@code definition.path}, without the null the baseline adds for a nullable field. */
    private <E extends Enum<E>> void assertVocabulary(String tool, Class<E> type, String definition, String... path) {
        JsonNode schema = outputSchema(tool);
        Set<String> baseline = new TreeSet<>();
        for (JsonNode allowed : schemaAt(schema, definition, path).path("enum")) {
            if (!allowed.isNull()) {
                baseline.add(allowed.stringValue());
            }
        }
        Set<String> actual = new TreeSet<>();
        for (E constant : type.getEnumConstants()) {
            actual.add(mapper.readTree(mapper.writeValueAsString(constant)).stringValue());
        }
        assertThat(baseline).as("%s: the baseline has an enum at %s %s", tool, definition, List.of(path)).isNotEmpty();
        assertThat(actual).as("%s %s %s: wire values of %s", tool, definition, List.of(path), type.getSimpleName()).isEqualTo(baseline);
    }

    /** The schema of a property reached from a definition: a segment is a property name, or "[]" for the items of an array; a nullable branch is skipped. */
    private JsonNode schemaAt(JsonNode root, String definition, String... segments) {
        JsonNode node = withoutNull(root.path("$defs").path(definition), root);
        for (String segment : segments) {
            node = "[]".equals(segment) ? withoutNull(node.path("items"), root) : withoutNull(node.path("properties").path(segment), root);
        }
        assertThat(node.isMissingNode()).as("baseline schema at %s %s", definition, List.of(segments)).isFalse();
        return node;
    }

    private JsonNode withoutNull(JsonNode schema, JsonNode root) {
        JsonNode resolved = resolve(schema, root);
        if (!resolved.has("anyOf")) {
            return resolved;
        }
        for (JsonNode branch : resolved.path("anyOf")) {
            JsonNode candidate = resolve(branch, root);
            if (!(candidate.path("type").isString() && "null".equals(candidate.path("type").stringValue()))) {
                return candidate;
            }
        }
        throw new IllegalStateException("anyOf without a branch that is not null");
    }

    private JsonNode resolve(JsonNode schema, JsonNode root) {
        if (!schema.has("$ref")) {
            return schema;
        }
        String reference = schema.path("$ref").stringValue();
        String prefix = "#/$defs/";
        assertThat(reference).startsWith(prefix);
        JsonNode target = root.path("$defs").path(reference.substring(prefix.length()));
        assertThat(target.isMissingNode()).as("baseline definition %s", reference).isFalse();
        return resolve(target, root);
    }

    /** The reasons {@code value} does not satisfy {@code schemaNode}; empty means it does. */
    private List<String> violations(JsonNode value, JsonNode schemaNode, JsonNode root, String path, boolean exact) {
        List<String> problems = new ArrayList<>();
        JsonNode schema = resolve(schemaNode, root);
        if (schema.has("anyOf")) {
            for (JsonNode branch : schema.path("anyOf")) {
                if (violations(value, branch, root, path, exact).isEmpty()) {
                    return problems;
                }
            }
            problems.add(path + ": no anyOf branch accepts " + value);
            return problems;
        }
        if (schema.has("const")) {
            if (!sameValue(schema.path("const"), value)) {
                problems.add(path + ": expected the constant " + schema.path("const") + " but was " + value);
            }
            return problems;
        }
        if (schema.has("enum")) {
            boolean found = false;
            for (JsonNode allowed : schema.path("enum")) {
                found = found || sameValue(allowed, value);
            }
            if (!found) {
                problems.add(path + ": " + value + " is not in " + schema.path("enum"));
            }
            return problems;
        }
        Set<String> types = new TreeSet<>();
        JsonNode type = schema.path("type");
        if (type.isString()) {
            types.add(type.stringValue());
        } else if (type.isArray()) {
            for (JsonNode name : type) {
                types.add(name.stringValue());
            }
        }
        if (!types.isEmpty() && types.stream().noneMatch(name -> hasType(value, name))) {
            problems.add(path + ": " + value + " is not of type " + types);
            return problems;
        }
        if (value.isString()) {
            problems.addAll(stringProblems(value.stringValue(), schema, path));
        } else if (value.isIntegralNumber()) {
            problems.addAll(integerProblems(value.longValue(), schema, path));
        } else if (value.isArray()) {
            problems.addAll(arrayProblems(value, schema, root, path, exact));
        } else if (value.isObject()) {
            problems.addAll(objectProblems(value, schema, root, path, exact));
        }
        return problems;
    }

    private List<String> stringProblems(String text, JsonNode schema, String path) {
        List<String> problems = new ArrayList<>();
        if (schema.has("pattern") && !Pattern.compile(schema.path("pattern").stringValue()).matcher(text).find()) {
            problems.add(path + ": does not match " + schema.path("pattern").stringValue());
        }
        long length = text.codePointCount(0, text.length());
        if (schema.has("minLength") && length < schema.path("minLength").longValue()) {
            problems.add(path + ": shorter than " + schema.path("minLength"));
        }
        if (schema.has("maxLength") && length > schema.path("maxLength").longValue()) {
            problems.add(path + ": longer than " + schema.path("maxLength"));
        }
        return problems;
    }

    private List<String> integerProblems(long number, JsonNode schema, String path) {
        List<String> problems = new ArrayList<>();
        if (schema.has("minimum") && number < schema.path("minimum").longValue()) {
            problems.add(path + ": " + number + " is below " + schema.path("minimum"));
        }
        if (schema.has("exclusiveMinimum") && number <= schema.path("exclusiveMinimum").longValue()) {
            problems.add(path + ": " + number + " is not above " + schema.path("exclusiveMinimum"));
        }
        if (schema.has("maximum") && number > schema.path("maximum").longValue()) {
            problems.add(path + ": " + number + " is above " + schema.path("maximum"));
        }
        return problems;
    }

    private List<String> arrayProblems(JsonNode array, JsonNode schema, JsonNode root, String path, boolean exact) {
        List<String> problems = new ArrayList<>();
        if (schema.has("maxItems") && array.size() > schema.path("maxItems").longValue()) {
            problems.add(path + ": more than " + schema.path("maxItems") + " items");
        }
        JsonNode items = schema.path("items");
        if (!items.isMissingNode()) {
            for (int index = 0; index < array.size(); index++) {
                problems.addAll(violations(array.get(index), items, root, path + "[" + index + "]", exact));
            }
        }
        return problems;
    }

    private List<String> objectProblems(JsonNode object, JsonNode schema, JsonNode root, String path, boolean exact) {
        List<String> problems = new ArrayList<>();
        if (!schema.has("properties")) {
            return problems;
        }
        JsonNode declared = schema.path("properties");
        Set<String> allowed = new TreeSet<>(declared.propertyNames());
        Set<String> required = new TreeSet<>();
        for (JsonNode name : schema.path("required")) {
            required.add(name.stringValue());
        }
        Set<String> actual = new TreeSet<>(object.propertyNames());
        JsonNode additional = schema.path("additionalProperties");
        if (!additional.isBoolean() || additional.booleanValue()) {
            problems.add(path + ": the baseline must say additionalProperties false");
        }
        Set<String> unknown = new TreeSet<>(actual);
        unknown.removeAll(allowed);
        if (!unknown.isEmpty()) {
            problems.add(path + ": keys the baseline does not declare " + unknown);
        }
        Set<String> missing = new TreeSet<>(required);
        missing.removeAll(actual);
        if (!missing.isEmpty()) {
            problems.add(path + ": required keys that are not on the wire " + missing);
        }
        if (exact) {
            Set<String> absent = new TreeSet<>(allowed);
            absent.removeAll(actual);
            if (!absent.isEmpty()) {
                problems.add(path + ": declared keys that are not on the wire " + absent);
            }
        }
        for (String name : actual) {
            if (allowed.contains(name)) {
                problems.addAll(violations(object.path(name), declared.path(name), root, path + "." + name, exact));
            }
        }
        return problems;
    }

    private boolean hasType(JsonNode value, String type) {
        if ("null".equals(type)) {
            return value.isNull();
        }
        if ("boolean".equals(type)) {
            return value.isBoolean();
        }
        if ("string".equals(type)) {
            return value.isString();
        }
        if ("integer".equals(type)) {
            return value.isIntegralNumber();
        }
        if ("array".equals(type)) {
            return value.isArray();
        }
        if ("object".equals(type)) {
            return value.isObject();
        }
        throw new IllegalStateException("A schema type this helper does not know: " + type);
    }

    private boolean sameValue(JsonNode expected, JsonNode actual) {
        if (expected.isIntegralNumber() && actual.isIntegralNumber()) {
            return expected.longValue() == actual.longValue();
        }
        return expected.equals(actual);
    }
}
