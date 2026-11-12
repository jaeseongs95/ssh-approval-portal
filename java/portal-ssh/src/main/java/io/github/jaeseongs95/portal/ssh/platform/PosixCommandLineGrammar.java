package io.github.jaeseongs95.portal.ssh.platform;

import io.github.jaeseongs95.portal.domain.command.CommandLineAnalysis;
import io.github.jaeseongs95.portal.domain.command.CommandLineGrammar;
import io.github.jaeseongs95.portal.domain.command.Completeness;
import io.github.jaeseongs95.portal.domain.command.LinuxPolicyName;
import io.github.jaeseongs95.portal.domain.command.NormalizedName;
import io.github.jaeseongs95.portal.domain.command.SudoUse;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.io.Serial;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * Reads the program names out of a POSIX shell command line (the grammar of {@code sh}, {@code bash}, {@code dash} and {@code zsh} as far as a name policy needs
 * it): every simple command of a list, pipeline or {@code &&}/{@code ||} chain, the literal command of {@code $(...)} and back-quote substitutions, the program
 * behind {@code sudo} and its flags, and the line given to {@code sh|bash|dash|zsh -c}. It also says whether the line uses {@code sudo}. A construct it does not
 * know (an expansion, a here-document, a subshell, a reserved word, a line break, more than 16 levels of nesting) makes the answer
 * {@link Completeness#INCOMPLETE}; the answer is never an exception.
 *
 * <p>The command-line name grammar is a reading that lets the approval policy compare names only; it is neither a shell evaluator nor a risk classifier
 * (명령줄 이름 문법은 승인 정책이 이름만 비교하게 하는 읽기이며 셸 평가기도 위험 분류기도 아니다). It is the port of 2.x {@code command-line.mjs}. What a program
 * does with its arguments is not looked at: a registered program owns its argument capabilities, including interpreters.
 *
 * <p>The reading keeps state (the position in the line, the names found), so every call to {@link #analyze(CommandText)} makes a reader of its own; the bean
 * itself holds nothing that changes. It runs inside the JVM and starts no program.
 */
@Component
public final class PosixCommandLineGrammar implements CommandLineGrammar {

    /** The depth of nested wrappers ({@code sudo}, {@code sh -c}) and substitutions a line may have (2.x command-line.mjs). */
    private static final int MAX_NESTING = 16;
    /** Shell reserved words: a line that starts a command with one of them is compound syntax this grammar does not read. */
    private static final Set<String> RESERVED = Set.of("if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "select",
        "time", "!", "{", "}");
    private static final Set<String> SUDO_PLAIN_FLAGS = Set.of("-n", "--non-interactive", "-H", "-E", "--preserve-env", "-S", "-k");
    /** The sudo flags that take the next word as their value. */
    private static final Set<String> SUDO_VALUE_FLAGS = Set.of("-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "-T", "-R", "-D");
    /** The sudo flags that only ask for information; they are accepted when nothing follows them. */
    private static final Set<String> SUDO_INFO_FLAGS = Set.of("-l", "--list", "-v", "--validate", "-V", "--version", "--help");
    private static final Set<String> SHELLS = Set.of("sh", "bash", "dash", "zsh");
    private static final Set<String> SHELL_PLAIN_FLAGS = Set.of("--noprofile", "--norc", "--posix", "--restricted");
    /** The text of a program name that is written literally (the 2.x character class; the policy name adds its own 80-character limit). */
    private static final Pattern PROGRAM_NAME = Pattern.compile("[A-Za-z0-9_][A-Za-z0-9_.+-]*");
    /** The option letters of a shell, with at most one {@code c} (2.x command-line.mjs). */
    private static final Pattern SHELL_FLAG = Pattern.compile("[+-][abefhkmnprtuvxBCEHPTilrs]*c?[abefhkmnprtuvxBCEHPTilrs]*");
    private static final Pattern SUDO_ASSIGNED_OPTION = Pattern.compile("--(?:user|group|host|prompt|preserve-env)=");
    /** A file descriptor number in front of a redirection operator, such as the {@code 2} of {@code 2>/tmp/file}. */
    private static final Pattern DESCRIPTOR = Pattern.compile("[0-9]+(?=[<>])");
    private static final Pattern VARIABLE = Pattern.compile("\\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])");
    /** The characters that end a word when no quote is open (the JavaScript class {@code [ \t;&|()<>]}). */
    private static final String WORD_END = " \t;&|()<>";
    /** The characters that make a word a pattern or expansion (the JavaScript class {@code [*?\[\]{}~]}). */
    private static final String PATTERN_CHARACTERS = "*?[]{}~";
    /** The characters a backslash keeps escaping inside double quotes. */
    private static final String ESCAPED_IN_DOUBLE_QUOTES = "$`\"\\";
    private static final String SUDO = "sudo";

    @Override
    public CommandLineAnalysis analyze(CommandText command) {
        Reading reading = new Reader(command.value(), 0).read();
        Completeness completeness = reading.complete() && !reading.names().isEmpty() ? Completeness.COMPLETE : Completeness.INCOMPLETE;
        SudoUse sudo = reading.usesSudo() ? SudoUse.USES_SUDO : SudoUse.NO_SUDO;
        return new CommandLineAnalysis(reading.names(), completeness, sudo);
    }

    @Override
    public NormalizedName normalize(String proposedName) {
        return LinuxPolicyName.parse(proposedName);
    }

    @Override
    public TargetOs platform() {
        return TargetOs.LINUX;
    }

    /** What one reader found: the names in the order they were found, whether it is sure of the line and whether {@code sudo} is used. */
    private record Reading(List<String> names, boolean complete, boolean usesSudo) {
    }

    /** A word of a command: its text with quotes and escapes resolved, and whether an expansion or pattern makes the real text unknown. */
    private record Word(String text, boolean dynamic) {
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

    /** One reading of one line (or of a line nested in it). It is made for one call and thrown away, so its state never reaches another call. */
    private static final class Reader {

        /** What {@link #at(int)} answers beyond the end of the line. */
        private static final int END = -1;

        private final String source;
        private final int nesting;
        private final Set<String> names = new LinkedHashSet<>();
        private int index;
        private boolean usesSudo;

        Reader(String source, int nesting) {
            this.source = source;
            this.nesting = nesting;
        }

        Reading read() {
            boolean complete = true;
            try {
                if (!withinLimit() || source.isEmpty() || nesting > MAX_NESTING || hasLineBreakOrNul()) {
                    throw new Unknown();
                }
                line(0, false);
            } catch (Unknown refused) {
                // The line is not one the grammar knows: the names found so far are kept and the answer is incomplete.
                complete = false;
            }
            return new Reading(List.copyOf(names), complete, usesSudo);
        }

        private boolean withinLimit() {
            return source.length() <= CommandText.MAX_BYTES && Utf8Text.isWellFormed(source)
                && source.getBytes(StandardCharsets.UTF_8).length <= CommandText.MAX_BYTES;
        }

        private boolean hasLineBreakOrNul() {
            return source.indexOf('\r') >= 0 || source.indexOf('\n') >= 0 || source.indexOf('\0') >= 0;
        }

        /** The UTF-16 code unit at the position, or {@link #END}. */
        private int at(int position) {
            return position >= 0 && position < source.length() ? source.charAt(position) : END;
        }

        /** One command (a word list) is complete: its head is the program name. */
        private void invocation(List<Word> words, int depth) {
            if (words.isEmpty() || nesting + depth > MAX_NESTING) {
                throw new Unknown();
            }
            Word head = words.get(0);
            String headText = head.text();
            usesSudo |= SUDO.equals(headText.substring(headText.lastIndexOf('/') + 1));
            if (head.dynamic() || !PROGRAM_NAME.matcher(headText).matches() || RESERVED.contains(headText)) {
                throw new Unknown();
            }
            names.add(headText);
            if (SUDO.equals(headText)) {
                sudo(words, depth);
            } else if (SHELLS.contains(headText)) {
                shell(words, depth);
            }
            // Registered programs own their argument capabilities, including interpreters. Only literal nested shell syntax adds further shell names.
        }

        private void sudo(List<Word> words, int depth) {
            usesSudo = true;
            int n = 1;
            while (n < words.size() && words.get(n).text().startsWith("-")) {
                if (words.get(n).dynamic()) {
                    throw new Unknown();
                }
                String flag = words.get(n).text();
                n++;
                if ("--".equals(flag)) {
                    break;
                }
                if (SUDO_PLAIN_FLAGS.contains(flag)) {
                    continue;
                }
                if (SUDO_VALUE_FLAGS.contains(flag)) {
                    if (n >= words.size() || words.get(n).dynamic()) {
                        throw new Unknown();
                    }
                    n++;
                    continue;
                }
                if (SUDO_ASSIGNED_OPTION.matcher(flag).lookingAt()) {
                    continue;
                }
                if (SUDO_INFO_FLAGS.contains(flag) && n == words.size()) {
                    return;
                }
                throw new Unknown();
            }
            if (n == words.size()) {
                throw new Unknown();
            }
            invocation(words.subList(n, words.size()), depth + 1);
        }

        private void shell(List<Word> words, int depth) {
            int code = -1;
            for (int n = 1; n < words.size() && startsWithSign(words.get(n).text()); n++) {
                Word flag = words.get(n);
                if (flag.dynamic()) {
                    throw new Unknown();
                }
                String text = flag.text();
                if ("--".equals(text)) {
                    break;
                }
                if (SHELL_PLAIN_FLAGS.contains(text)) {
                    continue;
                }
                boolean hasC = text.indexOf('c') >= 0;
                if (!SHELL_FLAG.matcher(text).matches() || (text.startsWith("+") && hasC)) {
                    throw new Unknown();
                }
                if (hasC) {
                    code = n + 1;
                    break;
                }
            }
            if (code < 0) {
                return;
            }
            if (code >= words.size() || words.get(code).dynamic() || depth >= MAX_NESTING) {
                throw new Unknown();
            }
            Reading inner = new Reader(words.get(code).text(), nesting + depth + 1).read();
            names.addAll(inner.names());
            usesSudo |= inner.usesSudo();
            if (!inner.complete()) {
                throw new Unknown();
            }
        }

        private boolean startsWithSign(String text) {
            return !text.isEmpty() && (text.charAt(0) == '+' || text.charAt(0) == '-');
        }

        private Word word(int depth) {
            StringBuilder text = new StringBuilder();
            boolean dynamic = false;
            char quote = 0;
            boolean started = false;
            while (index < source.length()) {
                char c = source.charAt(index);
                if (quote == 0 && WORD_END.indexOf(c) >= 0) {
                    break;
                }
                started = true;
                if (c == '\'' && quote != '"') {
                    quote = quote == '\'' ? 0 : '\'';
                    index++;
                    continue;
                }
                if (c == '"' && quote != '\'') {
                    quote = quote == '"' ? 0 : '"';
                    index++;
                    continue;
                }
                if (c == '\\' && quote != '\'') {
                    index++;
                    if (index == source.length()) {
                        throw new Unknown();
                    }
                    if (quote == '"' && ESCAPED_IN_DOUBLE_QUOTES.indexOf(source.charAt(index)) < 0) {
                        text.append('\\');
                    }
                    text.append(source.charAt(index));
                    index++;
                    continue;
                }
                if (c == '$' && quote != '\'') {
                    dynamic = true;
                    if (at(index + 1) == '(' && at(index + 2) != '(') {
                        index += 2;
                        line(depth + 1, true);
                        text.append("<substitution>");
                        continue;
                    }
                    // Parameter and arithmetic expansion can itself contain executable syntax.
                    if (at(index + 1) == '{' || at(index + 1) == '(') {
                        throw new Unknown();
                    }
                    Matcher variable = VARIABLE.matcher(source);
                    variable.region(index, source.length());
                    if (!variable.lookingAt()) {
                        throw new Unknown();
                    }
                    text.append(variable.group());
                    index = variable.end();
                    continue;
                }
                if (c == '`' && quote != '\'') {
                    int end = source.indexOf('`', index + 1);
                    if (end < 0) {
                        throw new Unknown();
                    }
                    String program = source.substring(index + 1, end);
                    if (program.indexOf('\\') >= 0) {
                        throw new Unknown();
                    }
                    Reading inner = new Reader(program, nesting + depth + 1).read();
                    names.addAll(inner.names());
                    usesSudo |= inner.usesSudo();
                    if (!inner.complete()) {
                        throw new Unknown();
                    }
                    dynamic = true;
                    text.append("<substitution>");
                    index = end + 1;
                    continue;
                }
                if (quote == 0 && PATTERN_CHARACTERS.indexOf(c) >= 0) {
                    dynamic = true;
                }
                text.append(c);
                index++;
            }
            if (!started || quote != 0) {
                throw new Unknown();
            }
            return new Word(text.toString(), dynamic);
        }

        /** Reads a list of commands to the end of the line, or (nested) to the closing parenthesis of a {@code $(...)}. */
        private void line(int depth, boolean nested) {
            if (depth > MAX_NESTING) {
                throw new Unknown();
            }
            List<Word> words = new ArrayList<>();
            boolean needCommand = true;
            while (index < source.length()) {
                char c = source.charAt(index);
                if (c == ' ' || c == '\t') {
                    index++;
                    continue;
                }
                if (c == '#') {
                    index = source.length();
                    break;
                }
                if (c == ')') {
                    if (!nested) {
                        throw new Unknown();
                    }
                    if (!words.isEmpty()) {
                        invocation(words, depth);
                        needCommand = false;
                    }
                    if (needCommand) {
                        throw new Unknown();
                    }
                    index++;
                    return;
                }
                if (c == '(') {
                    throw new Unknown();
                }
                Matcher descriptor = DESCRIPTOR.matcher(source);
                descriptor.region(index, source.length());
                if (descriptor.lookingAt()) {
                    index = descriptor.end();
                    continue;
                }
                if (c == ';' || c == '&' || c == '|') {
                    if (words.isEmpty()) {
                        throw new Unknown();
                    }
                    invocation(words, depth);
                    words = new ArrayList<>();
                    char operator = source.charAt(index);
                    index++;
                    boolean doubled = at(index) == operator && operator != ';';
                    if (doubled) {
                        index++;
                    }
                    needCommand = doubled || operator == '|';
                    continue;
                }
                if (c == '<' || c == '>') {
                    // Redirection stays part of the approved command's effects; only substitutions in the destination are read, the path is never judged.
                    char operator = c;
                    index++;
                    if (at(index) == operator) {
                        if (operator == '<') {
                            throw new Unknown();
                        }
                        index++;
                    }
                    if (at(index) == '(' || at(index) == '&') {
                        throw new Unknown();
                    }
                    while (index < source.length() && (source.charAt(index) == ' ' || source.charAt(index) == '\t')) {
                        index++;
                    }
                    word(depth);
                    continue;
                }
                words.add(word(depth));
                needCommand = true;
            }
            if (nested) {
                throw new Unknown();
            }
            if (!words.isEmpty()) {
                invocation(words, depth);
                needCommand = false;
            }
            if (needCommand) {
                throw new Unknown();
            }
        }
    }
}
