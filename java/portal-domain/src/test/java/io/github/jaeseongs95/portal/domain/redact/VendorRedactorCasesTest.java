package io.github.jaeseongs95.portal.domain.redact;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.domain.classify.VendorCaseTable;
import io.github.jaeseongs95.portal.domain.classify.VendorCaseTable.Row;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;
import java.util.stream.IntStream;
import java.util.stream.Stream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.TestInstance.Lifecycle;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * The cases VR-274 to VR-317 and VR-520 of docs/migration/vendor-ssh-mcp-rules.md that a table can hold, read from {@code vendor/redactor-cases.tsv} (VR-290, VR-291,
 * VR-315, VR-316 are in {@link VendorRedactorRulesTest}, VR-318 is not ported). The expected values were traced from the vendor source by hand, not run (the
 * document, section 9, U-01): this test is the first run.
 */
@TestInstance(Lifecycle.PER_CLASS)
class VendorRedactorCasesTest {

    private static final String UNCHANGED = "<SAME>";
    private static final String THRESHOLD_MODE = "threshold=";

    private final VendorCaseTable table = new VendorCaseTable();

    Stream<Row> rows() {
        return table.read("redactor-cases.tsv").stream();
    }

    private OutputRedactor redactorFor(String mode) {
        if ("entropy".equals(mode)) {
            return new VendorOutputRedactor();
        }
        if ("plain".equals(mode)) {
            return VendorOutputRedactor.withoutEntropyScan();
        }
        if (mode.startsWith(THRESHOLD_MODE)) {
            return VendorOutputRedactor.withEntropyThreshold(Double.parseDouble(mode.substring(THRESHOLD_MODE.length())));
        }
        throw new IllegalArgumentException("Unknown mode " + mode);
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("rows")
    @DisplayName("VR-274~317, VR-520: a text goes through the vendor redaction rules and comes out as the vendor gives it")
    void redactsAsTheVendorRulesDo(Row row) {
        String input = table.decode(row.cell(1));
        String expected = UNCHANGED.equals(row.cell(3)) ? input : table.decode(row.cell(3));

        RedactedText actual = redactorFor(row.cell(2)).redact(input);

        assertThat(actual.value()).as("redaction of %s", row).isEqualTo(expected);
    }

    @Test
    @DisplayName("VR-274~317: every case id has a row here or a test in VendorRedactorRulesTest, and no row is lost")
    void theTableHasEveryCase() {
        Set<String> inRulesTest = Set.of("VR-290", "VR-291", "VR-315", "VR-316");
        Set<String> expected = IntStream.rangeClosed(274, 317).mapToObj(number -> String.format("VR-%03d", number)).filter(id -> !inRulesTest.contains(id))
            .collect(Collectors.toCollection(TreeSet::new));
        Set<String> found = rows().map(Row::id).collect(Collectors.toSet());

        assertThat(found).containsAll(expected).contains("VR-520");
        assertThat(rows().count()).isEqualTo(48);
    }
}
