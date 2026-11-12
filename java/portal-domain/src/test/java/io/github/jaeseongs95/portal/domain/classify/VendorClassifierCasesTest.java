package io.github.jaeseongs95.portal.domain.classify;

import static org.assertj.core.api.Assertions.assertThat;

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
 * The cases VR-001 to VR-273 (VR-013, VR-014, VR-133, VR-134, VR-192, VR-204 are in {@link VendorClassifierRulesTest}), VR-488, VR-514 and VR-515 of
 * docs/migration/vendor-ssh-mcp-rules.md, read from {@code vendor/classifier-cases.tsv}. The expected values were traced from the vendor source by hand, not run
 * (the document, section 9, U-01): this test is the first run. A row marked CHANGED expects a stricter class than the vendor gives (stage 2 design 13.4).
 */
@TestInstance(Lifecycle.PER_CLASS)
class VendorClassifierCasesTest {

    private static final int CLASS_COLUMN = 2;
    private static final int BINARY_COLUMN = 3;
    private static final int REJECTION_BINARY_COLUMN = 4;
    private static final int REJECTION_WORD_COLUMN = 5;

    private final VendorCaseTable table = new VendorCaseTable();
    private final VendorCommandClassifier classifier = new VendorCommandClassifier();

    Stream<Row> rows() {
        return table.read("classifier-cases.tsv").stream();
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("rows")
    @DisplayName("VR-001~273, VR-488, VR-514, VR-515: a command line gets the class, the binary and the rejection of the vendor rules")
    void classifiesAsTheVendorRulesDo(Row row) {
        String input = table.decode(row.cell(1));
        CommandClassification actual = classifier.classifyText(input);

        assertThat(actual.commandClass()).as("class of the command of %s", row).isEqualTo(CommandClass.fromWire(row.cell(CLASS_COLUMN)));
        if (!row.cell(BINARY_COLUMN).isEmpty()) {
            assertThat(actual.binary()).as("binary of %s", row).isEqualTo(row.cell(BINARY_COLUMN));
        }
        String rejectionBinary = row.cell(REJECTION_BINARY_COLUMN);
        if ("-".equals(rejectionBinary)) {
            assertThat(actual.readOnlyRejection()).as("rejection of %s", row).isEmpty();
        } else if (!rejectionBinary.isEmpty()) {
            assertThat(actual.readOnlyRejection()).as("rejection of %s", row)
                .contains(new ReadOnlyRejection(rejectionBinary, table.decode(row.cell(REJECTION_WORD_COLUMN))));
        }
    }

    @Test
    @DisplayName("VR-001~273: every case id has a row here or a test in VendorClassifierRulesTest, and no row is lost")
    void theTableHasEveryCase() {
        Set<String> inRulesTest = Set.of("VR-013", "VR-014", "VR-133", "VR-134", "VR-192", "VR-204");
        Set<String> expected = IntStream.rangeClosed(1, 273).mapToObj(number -> String.format("VR-%03d", number)).filter(id -> !inRulesTest.contains(id))
            .collect(Collectors.toCollection(TreeSet::new));
        Set<String> found = rows().map(Row::id).collect(Collectors.toSet());

        assertThat(found).containsAll(expected).contains("VR-488", "VR-514", "VR-515");
        assertThat(rows().count()).isEqualTo(386);
    }
}
