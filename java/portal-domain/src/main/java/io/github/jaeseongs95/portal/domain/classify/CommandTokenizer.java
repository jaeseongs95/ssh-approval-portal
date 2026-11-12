package io.github.jaeseongs95.portal.domain.classify;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.StringJoiner;

/**
 * Splits a command line into segments and words the way the vendor classifier does ({@code tokenizeSegmentsDetailed}, policy/classifier.js:837-931): by UTF-16
 * code unit, quotes and escapes by dialect, no variable or command expansion. Every classification rule runs on these words. The object has no state;
 * each call keeps its own scan state.
 */
final class CommandTokenizer {

    private static final char NO_QUOTE = '\0';
    /** The characters a backslash escapes inside double quotes: {@code $ ` " \} and a line feed (CL-T04). */
    private static final String DOUBLE_QUOTE_ESCAPABLE = "$`\"\\\n";
    /** What replaces a word with white space or a separator in the form the regular expression rules read, so that it does not read as a command (CL-T08). */
    private static final String PLACEHOLDER = "\0";

    private final ShellText text;

    CommandTokenizer(ShellText text) {
        this.text = text;
    }

    /** The segments of a command with quotes honoured. A quote left open reads the whole command again with quotes as ordinary characters (CL-T07). */
    List<Segment> segments(String command, Dialect dialect) {
        return segments(command, true, dialect);
    }

    List<Segment> segments(String command, boolean honorQuotes, Dialect dialect) {
        Scan scan = new Scan(text, command, honorQuotes, dialect);
        scan.run();
        return scan.quoteLeftOpen() ? segments(command, false, dialect) : scan.result();
    }

    /** The words of each segment, without the separators ({@code tokenizeSegments}). */
    List<List<String>> wordLists(String command, Dialect dialect) {
        List<List<String>> lists = new ArrayList<>();
        for (Segment segment : segments(command, dialect)) {
            lists.add(segment.words());
        }
        return lists;
    }

    /**
     * The form the regular expression rules read in addition to the raw command: words joined by a space, segments by {@code "; "}, and a word that has white
     * space or a separator in it (so it was quoted) replaced by NUL (CL-T08, {@code normalizeCommand}). The vendor caches eight results; that is not ported.
     */
    String normalized(String command, Dialect dialect) {
        StringJoiner joined = new StringJoiner("; ");
        for (Segment segment : segments(command, dialect)) {
            StringJoiner words = new StringJoiner(" ");
            for (String word : segment.words()) {
                words.add(hasWhiteSpaceOrSeparator(word) ? PLACEHOLDER : word);
            }
            joined.add(words.toString());
        }
        return joined.toString();
    }

    /**
     * The first word that has an unquoted, unescaped shell glob character ({@code *}, {@code ?}, {@code [}), or empty when no word has one (CL-G03,
     * {@code firstUnquotedGlobWord}, policy/classifier.js:44-95). It keeps its own quote and escape state, because the words the grammar reads have lost it.
     */
    Optional<String> firstUnquotedGlobWord(String command, boolean honorQuotes, Dialect dialect) {
        char quote = NO_QUOTE;
        boolean escaped = false;
        StringBuilder word = new StringBuilder();
        boolean globInWord = false;
        for (int i = 0; i < command.length(); i++) {
            char ch = command.charAt(i);
            if (escaped) {
                word.append(ch);
                escaped = false;
                continue;
            }
            if (quote != NO_QUOTE) {
                if (dialect.backslashEscapes() && ch == '\\' && quote == '"') {
                    escaped = true;
                    continue;
                }
                if (ch == quote) {
                    quote = NO_QUOTE;
                } else {
                    word.append(ch);
                }
                continue;
            }
            if (dialect.backslashEscapes() && ch == '\\') {
                escaped = true;
                continue;
            }
            if (honorQuotes && (ch == '"' || ch == '\'')) {
                quote = ch;
                continue;
            }
            if (text.isSpace(ch)) {
                if (globInWord) {
                    return Optional.of(word.toString());
                }
                word.setLength(0);
                globInWord = false;
                continue;
            }
            if (ch == '*' || ch == '?' || ch == '[') {
                globInWord = true;
            }
            word.append(ch);
        }
        if (honorQuotes && quote != NO_QUOTE) {
            return firstUnquotedGlobWord(command, false, dialect);
        }
        return globInWord ? Optional.of(word.toString()) : Optional.empty();
    }

    private boolean hasWhiteSpaceOrSeparator(String word) {
        for (int i = 0; i < word.length(); i++) {
            char c = word.charAt(i);
            if (text.isSpace(c) || c == ';' || c == '&' || c == '|' || c == '\n') {
                return true;
            }
        }
        return false;
    }

    /** The state of one scan. */
    private static final class Scan {

        private final ShellText text;
        private final String command;
        private final boolean honorQuotes;
        private final Dialect dialect;
        private final List<Segment> segments = new ArrayList<>();
        private final StringBuilder current = new StringBuilder();
        private List<String> words = new ArrayList<>();
        private String pending = "";
        private char quote = NO_QUOTE;
        private boolean escaped;
        private boolean quotedWord;

        Scan(ShellText text, String command, boolean honorQuotes, Dialect dialect) {
            this.text = text;
            this.command = command;
            this.honorQuotes = honorQuotes;
            this.dialect = dialect;
        }

        void run() {
            for (int i = 0; i < command.length(); i++) {
                char ch = command.charAt(i);
                if (escaped) {
                    current.append(ch);
                    escaped = false;
                    continue;
                }
                if (quote != NO_QUOTE) {
                    if (dialect.backslashEscapes() && ch == '\\' && quote == '"') {
                        if (i + 1 >= command.length() || DOUBLE_QUOTE_ESCAPABLE.indexOf(command.charAt(i + 1)) >= 0) {
                            escaped = true;
                            continue;
                        }
                        current.append(ch);
                        continue;
                    }
                    if (ch == quote) {
                        quote = NO_QUOTE;
                    } else {
                        current.append(ch);
                    }
                    continue;
                }
                if (dialect.backslashEscapes() && ch == '\\') {
                    escaped = true;
                    continue;
                }
                if (honorQuotes && (ch == '"' || ch == '\'')) {
                    quote = ch;
                    quotedWord = true;
                    continue;
                }
                if (ch == ';' || ch == '&' || ch == '|' || ch == '\n') {
                    endSegment(String.valueOf(ch));
                    continue;
                }
                if (text.isSpace(ch)) {
                    endWord();
                    continue;
                }
                current.append(ch);
            }
            endSegment("");
        }

        boolean quoteLeftOpen() {
            return quote != NO_QUOTE;
        }

        List<Segment> result() {
            return segments;
        }

        private void endWord() {
            if (current.length() > 0 || quotedWord) {
                words.add(current.toString());
            }
            current.setLength(0);
            quotedWord = false;
        }

        private void endSegment(String separator) {
            endWord();
            if (!words.isEmpty()) {
                segments.add(new Segment(words, pending));
            }
            words = new ArrayList<>();
            pending = separator;
        }
    }
}
