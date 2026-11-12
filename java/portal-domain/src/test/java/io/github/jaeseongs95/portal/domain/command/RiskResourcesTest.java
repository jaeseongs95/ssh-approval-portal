package io.github.jaeseongs95.portal.domain.command;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * S2-RE-01 to S2-RE-03 and the cases RC-A-860 and RC-A-868: the question and catalogue resources are the 2.x files word for word, and the question digest of 2.x is
 * reproduced from the Java record.
 *
 * <p>The 2.x working tree has CRLF line endings (a Windows checkout); the committed file has LF. The copy is the committed bytes: its length and SHA-256 are
 * pinned below, and the CRLF figures that stage 2 design 6.2 quotes ({@code 22856}, {@code 4644} bytes) are reproduced from the copy by turning each LF into CR LF,
 * so both ends are checked.
 */
class RiskResourcesTest {

    private static final String PROMPT_DIGEST = "77634c80b0c225777dca0ddc2766db5072b173b7a34e01fdf8e35a48560ac0c5";

    private final JsonMapper mapper = JsonMapper.builder().build();

    @Test
    @DisplayName("S2-RE-01 command-risks.json is the 2.x file: 22238 bytes (LF), SHA-256 85dd68f8..., and 22856 bytes with eb65ce4e... as CRLF")
    void commandRisksBytes() {
        byte[] bytes = resource("risk/command-risks.json");
        assertThat(bytes).hasSize(22_238);
        assertThat(sha256(bytes)).isEqualTo("85dd68f81a5e6416000b18a52bde0fc57269e8610c84e27f5bad0381fab2be59");
        byte[] crlf = toCrlf(bytes);
        assertThat(crlf).hasSize(22_856);
        assertThat(sha256(crlf)).isEqualTo("eb65ce4e1e1f73259a405afd5e4741fda1f529d1a64d2227bb33faff03c47d83");
    }

    @Test
    @DisplayName("S2-RE-01 automation-risk-question.json is the 2.x file: 4636 bytes (LF), SHA-256 db11888b..., and 4644 bytes with ef0f1cc1... as CRLF")
    void automationQuestionBytes() {
        byte[] bytes = resource("risk/automation-risk-question.json");
        assertThat(bytes).hasSize(4_636);
        assertThat(sha256(bytes)).isEqualTo("db11888baf8f6e60cd206fedf4d7e1d6a21e0b8979ab867dad43939f60ed43e1");
        byte[] crlf = toCrlf(bytes);
        assertThat(crlf).hasSize(4_644);
        assertThat(sha256(crlf)).isEqualTo("ef0f1cc10b76a0aa1203a690697be61b4d2017d3879c8a1f954e7202f04b8fbc");
    }

    @Test
    @DisplayName("S2-RE-02 RC-A-868 the question digest is the SHA-256 of the compact JSON of the record, as in 2.x, with version v5 and revision binary-r1")
    void questionDigest() {
        AutomationQuestion question = mapper.readValue(resource("risk/automation-risk-question.json"), AutomationQuestion.class);
        String compact = mapper.writeValueAsString(question);
        assertThat(compact).startsWith("{\"type\":\"choice\",\"instructions\":\"You classify the actual security");
        assertThat(compact).contains("\"criteria\":{\"low_risk\":\"The supplied evidence establishes");
        assertThat(sha256(compact.getBytes(StandardCharsets.UTF_8))).isEqualTo(PROMPT_DIGEST);
        assertThat(QuestionVersion.CURRENT.wire()).isEqualTo("ssh-command-risk-v5");
        assertThat(AutomationQuestion.PROMPT_REVISION).isEqualTo("ssh-command-risk-v5-binary-r1");
    }

    @Test
    @DisplayName("S2-RE-03 the three question files keep the English instructions and criteria of 2.x: SHA-256 of each text")
    void questionSentences() {
        assertQuestion("risk/safety-question.json", "ee612a58e47b78d103375f0b9b51bf246a5ff54c0727eefe2c99b595e5040959",
            "86aaba9e1265015794735d8b4f796756147e8b429e252c350510d7f6fe96d588", "efc4382132edcf361bb3bfc33002f46b15d9729c512ef98245c4454ccf75dae4");
        assertQuestion("risk/command-set-question.json", "a7d6de171ea8ce285be14335ed36ac02b344879ad4be95e23216d9240eeae54c",
            "e912c8587059651730e51250d67af5e5686b6063856db426c31eb61528537c15", "5c5288e8cf9b189934b6dd751087d7c72aa0d3371f84c44e52c0c8e6ec0f4500");
        assertQuestion("risk/windows-command-set-question.json", "26cc1136422b65f82d812a1634932a56771c786683c4c98c3d66e23155ac7d08",
            "e912c8587059651730e51250d67af5e5686b6063856db426c31eb61528537c15", "5c5288e8cf9b189934b6dd751087d7c72aa0d3371f84c44e52c0c8e6ec0f4500");
    }

    @Test
    @DisplayName("RC-A-860 the three questions ask for a binary answer: criteria are exactly high_risk and low_risk, and the version is not v4")
    void binaryQuestions() {
        for (String name : List.of("risk/safety-question.json", "risk/automation-risk-question.json", "risk/command-set-question.json")) {
            JsonNode criteria = mapper.readTree(resource(name)).path("criteria");
            assertThat(criteria.propertyNames()).as(name).containsExactlyInAnyOrder("high_risk", "low_risk");
        }
        assertThat(QuestionVersion.CURRENT).isNotEqualTo(QuestionVersion.V4);
    }

    @Test
    @DisplayName("S2-RE-01 the risk catalogue loads into the record: 64 names (12 low, 10 moderate, 42 high), sudo excluded, a name it does not know is unknown")
    void catalogueLoads() {
        CommandRiskCatalog catalog = mapper.readValue(resource("risk/command-risks.json"), CommandRiskCatalog.class);
        assertThat(catalog.commands()).hasSize(64);
        assertThat(catalog.commands().values().stream().filter(entry -> entry.riskLevel() == RiskLevel.LOW)).hasSize(12);
        assertThat(catalog.commands().values().stream().filter(entry -> entry.riskLevel() == RiskLevel.MODERATE)).hasSize(10);
        assertThat(catalog.commands().values().stream().filter(entry -> entry.riskLevel() == RiskLevel.HIGH)).hasSize(42);
        assertThat(catalog.authorityEffect()).isEqualTo(AuthorityEffect.NONE);
        assertThat(catalog.excludedCommands()).containsExactly("sudo");
        assertThat(catalog.defaultCommands()).containsExactly("pwd", "ls", "stat", "df", "du", "uname", "uptime", "whoami", "id", "hostname");
        assertThat(catalog.describe("ls")).isInstanceOf(RiskDescription.Known.class);
        assertThat(((RiskDescription.Known) catalog.describe("sh")).entry().capabilities()).containsExactly(RiskCapability.EXECUTE_CODE, RiskCapability.DELEGATE_COMMANDS);
        assertThat(catalog.describe("sudo")).isInstanceOf(RiskDescription.Unknown.class);
        assertThat(catalog.describe("no-such-program")).isEqualTo(new RiskDescription.Unknown(catalog.defaultRisk()));
        assertThat(catalog.defaultRisk().riskLevel()).isEqualTo(RiskLevel.UNKNOWN);
    }

    private void assertQuestion(String name, String instructionsSha, String lowRiskSha, String highRiskSha) {
        AutomationQuestion question = mapper.readValue(resource(name), AutomationQuestion.class);
        assertThat(question.type()).isEqualTo("choice");
        assertThat(sha256(question.instructions().getBytes(StandardCharsets.UTF_8))).as(name + " instructions").isEqualTo(instructionsSha);
        assertThat(sha256(question.criteria().lowRisk().getBytes(StandardCharsets.UTF_8))).as(name + " low_risk").isEqualTo(lowRiskSha);
        assertThat(sha256(question.criteria().highRisk().getBytes(StandardCharsets.UTF_8))).as(name + " high_risk").isEqualTo(highRiskSha);
    }

    private byte[] resource(String name) {
        try (InputStream in = RiskResourcesTest.class.getClassLoader().getResourceAsStream(name)) {
            assertThat(in).as(name).isNotNull();
            return in.readAllBytes();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private byte[] toCrlf(byte[] lf) {
        return new String(lf, StandardCharsets.UTF_8).replace("\n", "\r\n").getBytes(StandardCharsets.UTF_8);
    }

    private String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("Every Java platform has SHA-256", e);
        }
    }
}
