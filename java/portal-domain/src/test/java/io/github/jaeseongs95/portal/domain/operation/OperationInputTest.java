package io.github.jaeseongs95.portal.domain.operation;

import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.DIGESTER;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.REVISION;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.domain.file.FileBinding;
import io.github.jaeseongs95.portal.domain.file.FileName;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import io.github.jaeseongs95.portal.domain.path.WindowsRemotePath;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.SourceText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class OperationInputTest {

    private final Digest digest = new Digest("d".repeat(64));

    @Test
    @DisplayName("S2-ST-05 every input has the kind of its variant and writes its own fields into the contract form")
    void kindsAndForms() {
        OperationInput command = new CommandInput(new CommandText("ls"), new Utf8Text(""), new Utf8Text(""));
        OperationInput source = new SourceInput(new CommandText("python3 -"), digest, digest, 100, new Utf8Text("[]"), new Utf8Text("/tmp"), Elevation.NONE, digest, new Utf8Text(""),
            new Utf8Text(""));
        OperationInput upload = new UploadInput(new ArtifactId("b".repeat(48)), new PosixRemotePath("/tmp/a"), new FileName("a"), 10, digest, OverwriteMode.REPLACE, Elevation.NONE,
            new FileBinding.Unbound(), UploadProtocol.MCP_JSON_V1);
        OperationInput download = new DownloadInput(new WindowsRemotePath("C:\\a.txt"), Elevation.SUDO, FileBinding.of("alpha", REVISION.hex()), new Utf8Text(""), new Utf8Text(""));
        OperationInput agentCli = new AgentCliInput(digest);
        Map<OperationKind, OperationInput> byKind = Map.of(OperationKind.COMMAND, command, OperationKind.SOURCE, source, OperationKind.UPLOAD, upload, OperationKind.DOWNLOAD, download,
            OperationKind.AGENT_CLI, agentCli);
        for (Map.Entry<OperationKind, OperationInput> entry : byKind.entrySet()) {
            assertThat(entry.getValue().kind()).isEqualTo(entry.getKey());
        }
        List<Digest> forms = byKind.values().stream().map(input -> input.describeTo(new io.github.jaeseongs95.portal.domain.id.CanonicalForm()).digest(DIGESTER)).toList();
        assertThat(forms).doesNotHaveDuplicates();
    }

    @Test
    @DisplayName("S2-ST-05 a request for any kind is accepted with its own kind; two requests that differ only in the file binding or the elevation are different contracts")
    void bindingAndElevationAreContract() {
        UploadInput plain = new UploadInput(new ArtifactId("b".repeat(48)), new PosixRemotePath("/tmp/a"), new FileName("a"), 10, digest, OverwriteMode.REPLACE, Elevation.NONE,
            new FileBinding.Unbound(), UploadProtocol.UNSPECIFIED);
        UploadInput bound = new UploadInput(plain.artifactId(), plain.remotePath(), plain.fileName(), 10, digest, OverwriteMode.REPLACE, Elevation.NONE,
            FileBinding.of("alpha", REVISION.hex()), UploadProtocol.UNSPECIFIED);
        UploadInput elevated = new UploadInput(plain.artifactId(), plain.remotePath(), plain.fileName(), 10, digest, OverwriteMode.REPLACE, Elevation.SUDO, new FileBinding.Unbound(),
            UploadProtocol.UNSPECIFIED);
        NewOperation first = spec(plain);
        assertThat(first.kind()).isEqualTo(OperationKind.UPLOAD);
        assertThat(spec(plain).contractDigest()).isEqualTo(first.contractDigest());
        assertThat(spec(bound).contractDigest()).isNotEqualTo(first.contractDigest());
        assertThat(spec(elevated).contractDigest()).isNotEqualTo(first.contractDigest());
    }

    @Test
    @DisplayName("S2-VA-02 a source is 1 to 16384 bytes, its working directory at most 512 UTF-8 bytes; an upload is at most 64 MiB")
    void bounds() {
        Utf8Text none = new Utf8Text("");
        assertThat(new SourceInput(new CommandText("python3 -"), digest, digest, SourceText.MAX_BYTES, none, none, Elevation.NONE, digest, none, none).sourceBytes()).isEqualTo(16384);
        for (int bad : new int[] {0, -1, SourceText.MAX_BYTES + 1}) {
            assertThatThrownBy(() -> new SourceInput(new CommandText("python3 -"), digest, digest, bad, none, none, Elevation.NONE, digest, none, none))
                .isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> new SourceInput(new CommandText("python3 -"), digest, digest, 5, none, new Utf8Text("x".repeat(513)), Elevation.NONE, digest, none, none))
            .isInstanceOf(IllegalArgumentException.class);
        assertThat(new UploadInput(new ArtifactId("b".repeat(48)), new PosixRemotePath("/a"), new FileName("a"), UploadInput.MAX_BYTES, digest, OverwriteMode.FAIL_IF_EXISTS,
            Elevation.NONE, new FileBinding.Unbound(), UploadProtocol.UNSPECIFIED).sizeBytes()).isEqualTo(67108864);
        assertThatThrownBy(() -> new UploadInput(new ArtifactId("b".repeat(48)), new PosixRemotePath("/a"), new FileName("a"), UploadInput.MAX_BYTES + 1, digest,
            OverwriteMode.FAIL_IF_EXISTS, Elevation.NONE, new FileBinding.Unbound(), UploadProtocol.UNSPECIFIED)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S2-CO-04 the wire values of the kind, the approval mode, the decision kind and the twenty decision reasons are lowercase names")
    void wireValues() throws Exception {
        assertThat(Arrays.stream(OperationKind.values()).map(OperationKind::wire)).containsExactly("command", "source", "upload", "download", "agent_cli");
        assertThat(Arrays.stream(ApprovalMode.values()).map(ApprovalMode::wire)).containsExactly("owner", "automatic", "not_decided");
        assertThat(Arrays.stream(DecisionKind.values()).map(DecisionKind::wire)).containsExactly("execute", "review", "deny");
        assertThat(Arrays.stream(DecisionReason.values()).map(DecisionReason::wire)).containsExactly("policy_denied", "test_server_bypass", "source_execution_not_enabled",
            "source_privilege_policy_review", "source_command_policy_review", "sudo_not_enabled", "command_set", "disclosure_not_enabled", "context_required", "sensitive_input",
            "source_evidence_too_large", "budget_exhausted", "policy_changed", "evaluation_unavailable", "model_passed", "model_review", "observation_only", "evaluation_failed",
            "execution_busy", "execution_start_failed");
        JsonMapper mapper = new JsonMapper();
        assertThat(mapper.writeValueAsString(OperationKind.DOWNLOAD)).isEqualTo("\"download\"");
        assertThat(mapper.writeValueAsString(ApprovalMode.AUTOMATIC)).isEqualTo("\"automatic\"");
        assertThat(mapper.writeValueAsString(DecisionReason.SOURCE_EXECUTION_NOT_ENABLED)).isEqualTo("\"source_execution_not_enabled\"");
    }

    @Test
    @DisplayName("S2-SC-02 the state counts: a state that is not listed has none, a negative count is refused, open and active are summed from the states")
    void stateCounts() {
        StateCounts counts = new StateCounts(Map.of(OperationState.PENDING, 2, OperationState.QUEUED, 3, OperationState.RUNNING, 1, OperationState.COMPLETED, 9, OperationState.UNKNOWN, 4));
        assertThat(counts.of(OperationState.FAILED)).isZero();
        assertThat(counts.open()).isEqualTo(6);
        assertThat(counts.active()).isEqualTo(1);
        assertThat(counts.sum(OperationState.PENDING, OperationState.QUEUED)).isEqualTo(5);
        assertThatThrownBy(() -> new StateCounts(Map.of(OperationState.PENDING, -1))).isInstanceOf(IllegalArgumentException.class);
        assertThat(StateCounts.none().open()).isZero();
    }

    private NewOperation spec(UploadInput input) {
        return NewOperation.of(DIGESTER, new RequestKey("upload-request-key-1"), new OwnerId("fixture-owner"), new TargetId("alpha"), REVISION, new ProfileAlias("write-profile"),
            input, new ConflictKey.None(), new Deadline.None());
    }
}
