package io.github.jaeseongs95.portal.ssh.platform;

import io.github.jaeseongs95.portal.domain.command.CommandLineAnalysis;
import io.github.jaeseongs95.portal.domain.command.CommandLineGrammar;
import io.github.jaeseongs95.portal.domain.command.Completeness;
import io.github.jaeseongs95.portal.domain.command.NormalizedName;
import io.github.jaeseongs95.portal.domain.command.SudoUse;
import io.github.jaeseongs95.portal.domain.command.WindowsPolicyName;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.io.Serial;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * Reads the program and cmdlet names out of a Windows PowerShell 5.1 command line, as far as the line is plain literal text: a list of commands separated by
 * {@code ;} or {@code |}, each starting with a name that is a module-qualified cmdlet, an executable file name or an absolute executable path (optionally behind the
 * call operator {@code &} and, then only, quoted). Quotes contain literal arguments only. A bare name without an extension may be an alias or a function, so it is not
 * a name; expansion, script blocks, redirection, stop-parsing ({@code --%}), curved quotes and line breaks make the answer {@link Completeness#INCOMPLETE}, and the
 * line goes to the full evaluation. The answer is never an exception, and PowerShell never uses {@code sudo}.
 *
 * <p>The command-line name grammar is a reading that lets the approval policy compare names only; it is neither a shell evaluator nor a risk classifier
 * (명령줄 이름 문법은 승인 정책이 이름만 비교하게 하는 읽기이며 셸 평가기도 위험 분류기도 아니다). It is the port of 2.x {@code windows-command-line.mjs}; a name is the
 * comparison key of {@link WindowsPolicyName}.
 *
 * <p>The reading keeps state (the position in the line, the names found), so every call to {@link #analyze(CommandText)} makes a reader of its own; the bean
 * itself holds nothing that changes. It runs inside the JVM and starts no program.
 */
@Component
public final class WindowsCommandLineGrammar implements CommandLineGrammar {

    /** PowerShell reads ASCII and curved quotes as string delimiters, mixed. The text is not normalised; a line that has one goes to the full evaluation. */
    private static final Pattern CURVED_QUOTE = Pattern.compile("[\\u2018\\u2019\\u201c\\u201d]");
    /** The control characters of the C0 and C1 ranges; a TAB or a line break in the line is one of them (2.x windows-command-line.mjs). */
    private static final Pattern CONTROL = Pattern.compile("[\\u0000-\\u001f\\u007f-\\u009f]");
    /** The characters that end a word. */
    private static final String WORD_END = " \t;|";
    /** The characters an unquoted word may not contain: quoting, expansion, grouping, redirection, call and comment syntax. */
    private static final String UNQUOTED_FORBIDDEN = "'\"`$@(){}[],&<>#~";
    private static final String STOP_PARSING = "--%";

    @Override
    public CommandLineAnalysis analyze(CommandText command) {
        Reading reading = new Reader(command.value()).read();
        Completeness completeness = reading.complete() && !reading.names().isEmpty() ? Completeness.COMPLETE : Completeness.INCOMPLETE;
        return new CommandLineAnalysis(reading.names(), completeness, SudoUse.NO_SUDO);
    }

    @Override
    public NormalizedName normalize(String proposedName) {
        return WindowsPolicyName.parse(proposedName);
    }

    @Override
    public TargetOs platform() {
        return TargetOs.WINDOWS;
    }

    /** What one reader found: the names (comparison keys) in the order they were found and whether it is sure of the line. */
    private record Reading(List<String> names, boolean complete) {
    }

    /** A word of a command and whether it was written in quotes. */
    private record Word(String text, boolean quoted) {
    }

    /**
     * The "this line is not something the grammar knows" signal of the reader. It is control flow inside one {@link Reader#read()}, the counterpart of the
     * JavaScript {@code unknown()} that throws, and it never leaves the reader: the answer of the grammar is a value.
     */
    private static final class Unknown extends RuntimeException {

        @Serial
        private static final long serialVersionUID = 1L;

        Unknown() {
            super(null, null, false, false);
        }
    }

    /** One reading of one line. It is made for one call and thrown away, so its state never reaches another call. */
    private static final class Reader {

        /** What {@link #at(int)} answers beyond the end of the line. */
        private static final int END = -1;

        private final String source;
        private final Set<String> names = new LinkedHashSet<>();
        private int index;

        Reader(String source) {
            this.source = source;
        }

        Reading read() {
            boolean complete = true;
            try {
                if (!withinLimit() || new Utf8Text(source).isBlank() || CURVED_QUOTE.matcher(source).find() || CONTROL.matcher(source).find()) {
                    throw new Unknown();
                }
                commands();
            } catch (Unknown refused) {
                // The line is not one the grammar knows: the names found so far are kept and the answer is incomplete.
                complete = false;
            }
            return new Reading(new ArrayList<>(names), complete);
        }

        private boolean withinLimit() {
            return source.length() <= CommandText.MAX_BYTES && Utf8Text.isWellFormed(source)
                && source.getBytes(StandardCharsets.UTF_8).length <= CommandText.MAX_BYTES;
        }

        /** The UTF-16 code unit at the position, or {@link #END}. */
        private int at(int position) {
            return position >= 0 && position < source.length() ? source.charAt(position) : END;
        }

        private void whitespace() {
            while (at(index) == ' ' || at(index) == '\t') {
                index++;
            }
        }

        private void commands() {
            while (index < source.length()) {
                whitespace();
                boolean callOperator = false;
                if (at(index) == '&') {
                    callOperator = true;
                    index++;
                    whitespace();
                }
                Word head = word();
                if (!(WindowsPolicyName.parse(head.text()) instanceof NormalizedName.Accepted accepted) || (head.quoted() && !callOperator)) {
                    throw new Unknown();
                }
                names.add(accepted.name().key());
                whitespace();
                while (index < source.length() && source.charAt(index) != ';' && source.charAt(index) != '|') {
                    word();
                    whitespace();
                }
                if (index == source.length()) {
                    break;
                }
                char separator = source.charAt(index);
                index++;
                whitespace();
                if (index == source.length()) {
                    if (separator == '|') {
                        throw new Unknown();
                    }
                    break;
                }
                if (source.charAt(index) == ';' || source.charAt(index) == '|') {
                    throw new Unknown();
                }
            }
        }

        private Word word() {
            char quote = at(index) == '\'' || at(index) == '"' ? source.charAt(index++) : 0;
            StringBuilder text = new StringBuilder();
            if (quote != 0) {
                boolean closed = false;
                while (index < source.length()) {
                    char character = source.charAt(index);
                    index++;
                    if (character == quote) {
                        if (quote == '\'' && at(index) == '\'') {
                            text.append('\'');
                            index++;
                            continue;
                        }
                        closed = true;
                        break;
                    }
                    if (quote == '"' && (character == '$' || character == '`')) {
                        throw new Unknown();
                    }
                    text.append(character);
                }
                if (!closed || (index < source.length() && WORD_END.indexOf(source.charAt(index)) < 0)) {
                    throw new Unknown();
                }
            } else {
                while (index < source.length() && WORD_END.indexOf(source.charAt(index)) < 0) {
                    char character = source.charAt(index);
                    index++;
                    if (UNQUOTED_FORBIDDEN.indexOf(character) >= 0) {
                        throw new Unknown();
                    }
                    text.append(character);
                }
                if (text.isEmpty() || STOP_PARSING.contentEquals(text)) {
                    throw new Unknown();
                }
            }
            return new Word(text.toString(), quote != 0);
        }
    }
}
