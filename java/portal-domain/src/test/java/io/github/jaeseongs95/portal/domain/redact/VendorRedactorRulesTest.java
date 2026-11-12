package io.github.jaeseongs95.portal.domain.redact;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

import java.util.List;
import java.util.stream.IntStream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/**
 * The redactor cases that need a generated input or the entropy engine itself (VR-290, VR-291, VR-315, VR-316) and the porting risks of section 8 of
 * docs/migration/vendor-ssh-mcp-rules.md that concern it (RK-01, RK-03, RK-06, RK-08, RK-09, RK-10). The table cases are in {@link VendorRedactorCasesTest}.
 */
class VendorRedactorRulesTest {

    private static final String BEGIN = "-----BEGIN PRIVATE KEY-----";
    private static final String END = "-----END PRIVATE KEY-----";

    private final OutputRedactor redactor = new VendorOutputRedactor();
    private final OutputRedactor withoutEntropy = VendorOutputRedactor.withoutEntropyScan();

    @Test
    @DisplayName("VR-290 (RD-05): a private key body of 65536 characters is replaced, the length counts both markers (27 + 65536 + 25)")
    void aPrivateKeyBodyOfTheLimitIsReplaced() {
        String text = BEGIN + "A".repeat(65536) + END;

        assertThat(redactor.redact(text).value()).isEqualTo("[REDACTED:pem-private-key:65588]");
        assertThat(withoutEntropy.redact(text).value()).isEqualTo("[REDACTED:pem-private-key:65588]");
    }

    @Test
    @DisplayName("VR-291 (RD-05): a private key body of 65537 characters is not replaced, with the entropy scan and without")
    void aPrivateKeyBodyBeyondTheLimitIsNotReplaced() {
        String text = BEGIN + "A".repeat(65537) + END;

        assertThat(redactor.redact(text).value()).isEqualTo(text);
        assertThat(withoutEntropy.redact(text).value()).isEqualTo(text);
    }

    @Test
    @DisplayName("VR-315 (RD-11): the entropy of 20 characters of two kinds is 1 bit; the case text of the document has 18 characters, which is 0")
    void theEntropyOfTwoKindsIsOneBit() {
        EntropyRule rule = new EntropyRule(VendorOutputRedactor.DEFAULT_ENTROPY_THRESHOLD);

        assertThat(rule.shannonEntropy("ab".repeat(10))).isCloseTo(1.0, within(1e-12));
        assertThat("ababababababababab").as("the literal of VR-315 in the document").hasSize(18);
        assertThat(rule.shannonEntropy("ababababababababab")).isEqualTo(0.0);
    }

    @Test
    @DisplayName("VR-316 (RD-11): a text of 19 characters has no entropy, 20 different characters have log2(20)")
    void aTextShorterThanTwentyHasNoEntropy() {
        EntropyRule rule = new EntropyRule(VendorOutputRedactor.DEFAULT_ENTROPY_THRESHOLD);

        assertThat(rule.shannonEntropy("abcdefghijklmnopqrs")).isEqualTo(0.0);
        assertThat(rule.shannonEntropy("abcdefghijklmnopqrst")).isCloseTo(Math.log(20) / Math.log(2), within(1e-12));
        assertThat(rule.shannonEntropy("a".repeat(24))).isEqualTo(0.0);
    }

    @Test
    @DisplayName("RD-11, RK-08: the entropy of 26 different characters is log2(26), a character that appears twice lowers it")
    void theEntropyFollowsTheCharacterCounts() {
        EntropyRule rule = new EntropyRule(VendorOutputRedactor.DEFAULT_ENTROPY_THRESHOLD);
        double log2Of26 = Math.log(26) / Math.log(2);
        double expectedForSlash = 26.0 / 28 * (Math.log(28) / Math.log(2)) + 2.0 / 28 * (Math.log(14) / Math.log(2));

        assertThat(rule.shannonEntropy("abcdefghijklmnopqrstuvwxyz")).isCloseTo(log2Of26, within(1e-12));
        assertThat(rule.shannonEntropy("/abcdefghijklmnopqrstuvwxyz/")).isCloseTo(expectedForSlash, within(1e-12));
    }

    @Test
    @DisplayName("RD-10: a threshold that no text reaches replaces nothing, a threshold of 0 replaces every run of 20 characters that is not one kind")
    void theThresholdIsStrict() {
        String text = "xx abcdefghijklmnopqrstuvwxyz xx " + "a".repeat(30);

        assertThat(VendorOutputRedactor.withEntropyThreshold(100).redact(text).value()).isEqualTo(text);
        assertThat(VendorOutputRedactor.withEntropyThreshold(0).redact(text).value()).isEqualTo("xx [REDACTED:entropy:26] xx " + "a".repeat(30));
    }

    @Test
    @DisplayName("RK-09: a $ or a backslash in the text around a secret is copied as it is, not read as a group reference or an escape")
    void theReplacementIsNotInterpreted() {
        String text = "cost $1 and C:\\path ${x} AKIAIOSFODNN7EXAMPLE \\1 $0";

        assertThat(redactor.redact(text).value()).isEqualTo("cost $1 and C:\\path ${x} [REDACTED:aws-access-key:20] \\1 $0");
    }

    @Test
    @DisplayName("RK-03 (RD-06, RD-07): the white space of a pattern is the white space of JavaScript: NBSP and U+FEFF count, U+0085 does not")
    void javaScriptWhiteSpaceIsUsedInThePatterns() {
        assertThat(withoutEntropy.redact("Bearer\u00A0abc").value()).isEqualTo("[REDACTED:bearer-auth:10]");
        assertThat(withoutEntropy.redact("Bearer\uFEFFabc").value()).isEqualTo("[REDACTED:bearer-auth:10]");
        assertThat(withoutEntropy.redact("Bearer\u0085abc").value()).isEqualTo("Bearer\u0085abc");
        assertThat(withoutEntropy.redact("api_key\u00A0=\u00A0'abcdefghij1234567890'").value()).isEqualTo("[REDACTED:generic-api-key:32]");
    }

    @Test
    @DisplayName("RK-06 (RD-07): the case folding of the api key pattern is ASCII only: the Kelvin sign is not a k")
    void caseFoldingIsAsciiOnly() {
        String kelvin = "api_\u212Aey=\"abcdefghij1234567890\"";

        assertThat(withoutEntropy.redact(kelvin).value()).isEqualTo(kelvin);
        assertThat(withoutEntropy.redact("API_KEY=\"abcdefghij1234567890\"").value()).isEqualTo("[REDACTED:generic-api-key:30]");
    }

    @Test
    @DisplayName("RD-09: the patterns run in order, each on the result of the one before; the secret kinds are seven")
    void thePatternsRunInOrder() {
        String text = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_DEF-123 AKIAIOSFODNN7EXAMPLE";

        assertThat(redactor.redact(text).value()).isEqualTo("Bearer [REDACTED:jwt:48] [REDACTED:aws-access-key:20]");
        assertThat(redactor.redact("").value()).isEmpty();
        assertThat(redactor.redact("nothing secret here").value()).isEqualTo("nothing secret here");
    }

    @Test
    @DisplayName("RD-12: a text that is already redacted is redacted again as any other text, there is no skip rule")
    void thereIsNoSkipRule() {
        assertThat(redactor.redact("[REDACTED:aws-access-key:20]").value()).isEqualTo("[REDACTED:aws-access-key:20]");
        assertThat(redactor.redact("Bearer [REDACTED:jwt:48]").value()).as("[ is not in the character set of a bearer token").isEqualTo("Bearer [REDACTED:jwt:48]");
    }

    @Test
    @DisplayName("RedactedText: a value cannot be null")
    void aRedactedTextHasAValue() {
        assertThat(new RedactedText("x").value()).isEqualTo("x");
        assertThatThrownBy(() -> new RedactedText(null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("RK-12: one instance serves many threads and gives the same answer")
    void oneInstanceServesManyThreads() {
        List<String> texts = List.of("AKIAIOSFODNN7EXAMPLE", "Bearer abc.def", "abcdefghijklmnopqrstuvwxyz", "plain text", BEGIN + "x" + END);
        List<String> expected = texts.stream().map(text -> redactor.redact(text).value()).toList();

        List<String> parallel = IntStream.range(0, 150).parallel().mapToObj(i -> redactor.redact(texts.get(i % texts.size())).value()).toList();

        for (int i = 0; i < parallel.size(); i++) {
            assertThat(parallel.get(i)).as("text %d", i % texts.size()).isEqualTo(expected.get(i % texts.size()));
        }
    }

    @Test
    @Timeout(value = 60)
    @DisplayName("RK-10 (RD-05): many BEGIN markers without an END do not make the private key pattern run away: each one scans at most the 64 KiB body bound")
    void manyUnmatchedBeginMarkersAreScannedInReasonableTime() {
        String text = (BEGIN + "\n").repeat(2000);

        assertThat(redactor.redact(text).value()).isEqualTo(text);
    }

    @Test
    @DisplayName("RK-01 (RD-05): a private key body with characters outside the Basic Multilingual Plane is replaced, and the length is counted in UTF-16 code units")
    void theLengthIsCountedInUtf16CodeUnits() {
        String body = "\uD83D\uDE00".repeat(3);

        assertThat(redactor.redact(BEGIN + body + END).value()).isEqualTo("[REDACTED:pem-private-key:" + (27 + 6 + 25) + "]");
    }
}
