package io.github.jaeseongs95.portal.domain.classify;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reads a case table of {@code src/test/resources/vendor}: UTF-8 text, one case per line, cells separated by TAB, lines that start with {@code #} and empty lines
 * skipped. A cell may name a character that is hard to type in a text file ({@code <LF>}, {@code <NBSP>}, {@code <U+1F600>}); {@link #decode(String)} turns the
 * names into the characters. The redactor tests read their table with the same class.
 */
public final class VendorCaseTable {

    private static final Pattern CODE_POINT = Pattern.compile("<U\\+([0-9A-Fa-f]{4,6})>");

    /** One case: its id (VR-nnn), the line of the file (for a failure message) and its cells; a cell that the line does not have is the empty string. */
    public record Row(String id, int line, List<String> cells) {

        public String cell(int index) {
            return index < cells.size() ? cells.get(index) : "";
        }

        /** The name of a test invocation: the case id and the line, no case text (a case may hold a control character that a test report cannot carry). */
        @Override
        public String toString() {
            return id + " (line " + line + ")";
        }
    }

    public List<Row> read(String resourceName) {
        String path = "/vendor/" + resourceName;
        try (InputStream stream = Objects.requireNonNull(VendorCaseTable.class.getResourceAsStream(path), path + " is not on the test class path");
            BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            List<Row> rows = new ArrayList<>();
            String text;
            int line = 0;
            while ((text = reader.readLine()) != null) {
                line++;
                if (text.isEmpty() || text.startsWith("#")) {
                    continue;
                }
                List<String> cells = List.of(text.split("\t", -1));
                rows.add(new Row(cells.get(0), line, cells));
            }
            return rows;
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot read " + path, e);
        }
    }

    /** Replaces the names of the cell by the characters: {@code <EMPTY>} (the whole cell), {@code <SP>}, {@code <TAB>}, {@code <LF>}, {@code <CR>}, {@code <NBSP>}, {@code <NUL>}, {@code <U+hhhh>}. */
    public String decode(String cell) {
        if ("<EMPTY>".equals(cell)) {
            return "";
        }
        String named = cell.replace("<SP>", " ").replace("<TAB>", "\t").replace("<LF>", "\n").replace("<CR>", "\r").replace("<NBSP>", " ").replace("<NUL>", "\0");
        Matcher matcher = CODE_POINT.matcher(named);
        StringBuilder result = new StringBuilder();
        int copiedUpTo = 0;
        while (matcher.find()) {
            result.append(named, copiedUpTo, matcher.start()).appendCodePoint(Integer.parseInt(matcher.group(1), 16));
            copiedUpTo = matcher.end();
        }
        return result.append(named, copiedUpTo, named.length()).toString();
    }
}
