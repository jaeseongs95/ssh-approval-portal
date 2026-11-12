package io.github.jaeseongs95.portal.domain.command;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.domain.contract.ErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.text.SourceText;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** RC-A-439, RC-A-752, RC-A-753, RC-A-754 and RC-A-758: the caller's description, the server facts and what counts as secret text (2.x test/execution-context.test.mjs). */
class ExecutionContextTest {

    @Test
    @DisplayName("RC-A-752 a sensitive path may be mentioned in a description; the command that reads it is still sensitive")
    void sensitivePathsAreContextButCommandsReadingThemAreSensitive() {
        for (String path : List.of(".env", "/etc/shadow", "/home/operator/.ssh/id_ed25519", "/secrets/service")) {
            String description = "The service reads " + path + " at start and the check is read only.";
            assertThat(new CallerContext(description).value()).isEqualTo(description);
            assertThat(new SensitiveText("cat " + path).isSensitive()).as(path).isTrue();
            assertThat(new SensitiveText(description).containsCredential()).as(path).isFalse();
        }
        assertThat(new SensitiveText("ls /tmp").isSensitive()).isFalse();
        assertThat(new SensitiveText("cat /usr/share/environment").isSensitive()).isFalse();
    }

    @Test
    @DisplayName("RC-A-753 / RC-A-439 credential material in a description is refused with COMMAND_CONTEXT_CONTAINS_SECRET")
    void credentialsAreRefused() {
        for (String text : List.of("-----BEGIN PRIVATE KEY-----", "send Bearer synthetic-credential", "api_key=synthetic", "api-key: x", "apikey = x", "password: x", "secret=x", "token=x",
            "TOKEN = x", "password=synthetic-only")) {
            assertThat(codeOf(text)).as(text).isEqualTo(RequestErrorCode.COMMAND_CONTEXT_CONTAINS_SECRET);
        }
    }

    @Test
    @DisplayName("RC-A-753 text with a NUL, or null, is INVALID_COMMAND_CONTEXT; above 8192 characters is COMMAND_CONTEXT_TOO_LARGE; 8192 Hangul syllables pass")
    void invalidAndOversizedDescriptions() {
        assertThat(codeOf("a\0b")).isEqualTo(RequestErrorCode.INVALID_COMMAND_CONTEXT);
        assertThat(codeOf(null)).isEqualTo(RequestErrorCode.INVALID_COMMAND_CONTEXT);
        assertThat(codeOf("lone surrogate \ud800")).isEqualTo(RequestErrorCode.INVALID_COMMAND_CONTEXT);
        assertThat(codeOf("a".repeat(8193))).isEqualTo(RequestErrorCode.COMMAND_CONTEXT_TOO_LARGE);
        assertThat(new CallerContext("a".repeat(8192)).value()).hasSize(8192);
        assertThat(new CallerContext("한".repeat(8192)).value()).hasSize(8192);
        assertThat(CallerContext.MAX_CHARS).isEqualTo(8192);
        assertThat(CallerContext.none().isBlank()).isTrue();
        assertThat(new CallerContext(" \t\n ").isBlank()).isTrue();
        assertThat(new CallerContext(" x ").isBlank()).isFalse();
    }

    @Test
    @DisplayName("RC-A-753 the refusal is a contract answer: it is not retryable and nothing was attempted")
    void theRefusalIsAContractAnswer() {
        assertThatThrownBy(() -> new CallerContext("password=x")).isInstanceOfSatisfying(RequestRefusedException.class, refusal -> {
            assertThat(refusal.retryable()).isFalse();
            assertThat(refusal.attempt().wire()).isEqualTo(Boolean.FALSE);
            assertThat(refusal.getMessage()).doesNotContain("password=x");
        });
    }

    @Test
    @DisplayName("RC-A-758 a normalised secret reference is a public identifier, not credential material; a literal next to it still is")
    void secretReferences() {
        for (String reference : List.of("secret://local-file/windows-gui-agent", "secret://a/b", "secret://" + "h".repeat(32) + "/n", "secret://h/" + "n".repeat(64))) {
            assertThat(new SensitiveText(reference).containsCredential()).as(reference).isFalse();
            assertThat(new CallerContext("use " + reference + " for the login").value()).contains(reference);
            assertThat(new SensitiveText("open " + reference + ", then run").isSensitive()).as(reference).isFalse();
            assertThat(new SensitiveText(reference + " password=x").containsCredential()).as(reference).isTrue();
            assertThat(new SensitiveText("token=x " + reference).containsCredential()).as(reference).isTrue();
            assertThat(codeOf("Bearer x " + reference)).isEqualTo(RequestErrorCode.COMMAND_CONTEXT_CONTAINS_SECRET);
        }
    }

    @Test
    @DisplayName("RC-A-758 a reference that is not in the normal form is credential material: upper case, spaces, empty name, extra path, query, escapes, over-long parts")
    void malformedSecretReferences() {
        for (String bad : List.of("SECRET://local-file/name", "secret://Local/name", "secret://local file/name", "secret://local/", "secret://local/name/extra", "secret://local/name?x=1",
            "secret://local/name%20x", "secret://local\\name", "xsecret://local/name", "secret://" + "h".repeat(33) + "/n", "secret://h/" + "n".repeat(65), "secret://local/name#frag")) {
            assertThat(new SensitiveText(bad).containsCredential()).as(bad).isTrue();
        }
    }

    @Test
    @DisplayName("RC-A-754 the server facts keep the thirteen whitelisted names only; a caller's name such as adminToken never reaches the evaluator")
    void serverFactsAreWhitelisted() {
        ServerFacts facts = ServerFacts.whitelisting(Map.of("targetId", new FactValue.Text("synthetic"), "profile", new FactValue.Text("writer"), "sshTarget",
            new FactValue.Text("fixture@127.0.0.1:22"), "adminToken", new FactValue.Text("must-not-be-sent"), "apiKey", new FactValue.Text("must-not-be-sent")));
        assertThat(facts.values()).containsOnlyKeys(ServerFactKey.TARGET_ID, ServerFactKey.PROFILE, ServerFactKey.SSH_TARGET);
        assertThat(ServerFactKey.values()).hasSize(13);
        assertThat(ServerFactKey.values()).extracting(ServerFactKey::wire).containsExactly("targetId", "targetDisplayName", "targetRevision", "profile", "sshTarget",
            "commandClass", "policyRevision", "requestState", "externalDisclosure", "modelExecution", "fallback", "targetPlatform", "commandLanguage");
        assertThat(ServerFacts.whitelisting(Map.of("TARGETID", new FactValue.Flag(true))).values()).isEmpty();
    }

    @Test
    @DisplayName("RC-A-754 a server fact is text of at most 2048 characters, a finite number, a flag or an absent value")
    void factValues() {
        assertThat(new FactValue.Text("x".repeat(2048)).value()).hasSize(2048);
        assertThatThrownBy(() -> new FactValue.Text("x".repeat(2049))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new FactValue.Count(Double.NaN)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new FactValue.Count(Double.POSITIVE_INFINITY)).isInstanceOf(IllegalArgumentException.class);
        assertThat(new FactValue.Count(7).value()).isEqualTo(7.0);
    }

    @Test
    @DisplayName("RC-A-754 the context for the evaluator keeps the caller's text whole (8192 characters) apart from the server facts and the source evidence")
    void executionContextKeepsThreePartsApart() {
        String longSituation = "The nightly job failed after the upgrade. ".repeat(100);
        CallerContext caller = new CallerContext(longSituation);
        ExecutionContext context = new ExecutionContext(caller, ServerFacts.none(), new SourceEvidence.NoSource());
        assertThat(context.caller().value()).isEqualTo(longSituation);
        assertThat(context.serverFacts().values()).isEmpty();
        assertThat(context.source()).isInstanceOf(SourceEvidence.NoSource.class);
    }

    @Test
    @DisplayName("RC-A-754 the evaluation context is at most 12288 characters, plus 117760 for source evidence, counted in UTF-16 units")
    void assessmentContextLimits() {
        assertThat(AssessmentContext.MAX_CHARS).isEqualTo(12_288);
        assertThat(SourceEvidence.MAX_CHARS).isEqualTo(117_760);
        SourceEvidence none = new SourceEvidence.NoSource();
        assertThat(new AssessmentContext("x".repeat(12_288), none).text()).hasSize(12_288);
        assertThatThrownBy(() -> new AssessmentContext("x".repeat(12_289), none)).isInstanceOf(IllegalArgumentException.class);
        SourceEvidence source = new SourceEvidence.Submitted(new SourceText("print(1)"), new Digest("c".repeat(64)));
        assertThat(new AssessmentContext("x".repeat(12_288 + 117_760), source).text()).hasSize(130_048);
        assertThatThrownBy(() -> new AssessmentContext("x".repeat(12_288 + 117_761), source)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new AssessmentContext("lone \ud800", none)).isInstanceOf(IllegalArgumentException.class);
    }

    private ErrorCode codeOf(String text) {
        return refusalOf(text).code();
    }

    private RequestRefusedException refusalOf(String text) {
        try {
            new CallerContext(text);
        } catch (RequestRefusedException refusal) {
            return refusal;
        }
        throw new AssertionError("The description was accepted: " + text);
    }
}
