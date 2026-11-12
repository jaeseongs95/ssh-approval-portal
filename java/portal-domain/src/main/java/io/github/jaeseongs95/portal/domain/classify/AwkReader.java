package io.github.jaeseongs95.portal.domain.classify;

import io.github.jaeseongs95.portal.domain.classify.AwkToken.Kind;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Reads the program of an {@code awk} command so that the classifier can tell a program that only prints from one that writes a file or runs a command (vendor
 * policy/awk.js and policy/classifier.js:1927-1971, rules AW-01 to AW-09). It lexes the program into a few token kinds and walks them; everything it cannot
 * read is reported as unreadable, which the classifier treats as dangerous.
 */
final class AwkReader {

    /** The program names this reader is for (AW-01). */
    private static final Set<String> AWK_NAMES = Set.of("awk", "gawk", "mawk", "nawk");

    /** Flags that take a value: {@code -F} and {@code -v} (the value is skipped), {@code -f} (a program file, unreadable) (AW-01). */
    private static final Set<String> VALUE_FLAGS = Set.of("-F", "-v", "-f");

    private static final Set<String> INFO_FLAGS = Set.of("--version", "--help");

    /** A program longer than this is not read (AW-03). */
    private static final int MAX_PROGRAM_CHARS = 256 * 1024;

    /** Targets of {@code print > "..."} that are not files (AW-07). */
    private static final Set<String> NON_FILE_TARGETS = Set.of("/dev/stdout", "/dev/stderr", "/dev/null", "/dev/fd/1", "/dev/fd/2");

    /** The multi-character operators, longest first within a first character (AW-06). The order is the vendor's: the first one that matches wins. */
    private static final Map<Character, List<String>> OPERATORS_BY_FIRST = Map.ofEntries(
        Map.entry('*', List.of("**=", "*=", "**")),
        Map.entry('|', List.of("|&", "||")),
        Map.entry('&', List.of("&&")),
        Map.entry('=', List.of("==")),
        Map.entry('!', List.of("!=", "!~")),
        Map.entry('<', List.of("<=")),
        Map.entry('>', List.of(">=", ">>")),
        Map.entry('+', List.of("++", "+=")),
        Map.entry('-', List.of("--", "-=")),
        Map.entry('/', List.of("/=")),
        Map.entry('%', List.of("%=")),
        Map.entry('^', List.of("^=")));

    /** After one of these a {@code /} starts a regular expression (AW-04). */
    private static final Set<String> KEYWORDS = Set.of("print", "printf", "if", "while", "do", "for", "return", "delete", "else", "in", "BEGIN", "END", "function", "exit",
        "next");

    private static final Set<String> NOT_BEFORE_REGEX = Set.of(")", "]", "++", "--", "$");

    private final ShellText text;
    private final CommandTokenizer tokenizer;
    private final LaunchPrefixes prefixes;
    private final ProgramCarriers carriers;

    AwkReader(ShellText text, CommandTokenizer tokenizer, LaunchPrefixes prefixes, ProgramCarriers carriers) {
        this.text = text;
        this.tokenizer = tokenizer;
        this.prefixes = prefixes;
        this.carriers = carriers;
    }

    /** What the awk invocation of a segment's words has, or empty when the program is not awk or the invocation has no program ({@code awk}, {@code awk --version}) (AW-02). */
    Optional<AwkFindings> findings(List<String> words) {
        int index = prefixes.effectiveCommandIndex(words);
        if (index == -1) {
            return Optional.empty();
        }
        if (!AWK_NAMES.contains(text.stripPath(text.unquote(words.get(index))))) {
            return Optional.empty();
        }
        return read(words.subList(index + 1, words.size()));
    }

    /**
     * True when an awk program in the command writes a file, cannot be read, or pipes into a command that reads its program from standard input
     * ({@code print | "sh"}) (AW-08, {@code hasDangerousAwk}).
     */
    boolean hasDangerousAwk(String command, Dialect dialect) {
        for (Segment segment : tokenizer.segments(command, dialect)) {
            Optional<AwkFindings> found = findings(segment.words());
            if (found.isEmpty()) {
                continue;
            }
            AwkFindings awk = found.orElseThrow();
            if (awk.writesFile() || awk.unreadable()) {
                return true;
            }
            for (String target : awk.pipedInto()) {
                List<Segment> stage = tokenizer.segments(target, dialect);
                if (!stage.isEmpty() && carriers.readsProgramFromStdin(stage.get(0).words())) {
                    return true;
                }
            }
        }
        return false;
    }

    /** Reads the arguments of an awk command (the words after {@code awk}): options first, then the program ({@code readAwkInvocation}, AW-01). */
    Optional<AwkFindings> read(List<String> args) {
        int i = 0;
        while (i < args.size()) {
            String word = args.get(i);
            if ("--".equals(word)) {
                i++;
                break;
            }
            if ("-".equals(word) || !word.startsWith("-")) {
                break;
            }
            if (INFO_FLAGS.contains(word)) {
                i++;
                continue;
            }
            String flag = word.substring(0, 2);
            if (VALUE_FLAGS.contains(flag)) {
                if ("-f".equals(flag)) {
                    return Optional.of(AwkFindings.notReadable());
                }
                i += word.length() == 2 ? 2 : 1;
                continue;
            }
            return Optional.of(AwkFindings.notReadable());
        }
        if (i >= args.size()) {
            return Optional.empty();
        }
        String program = args.get(i);
        if (program.length() > MAX_PROGRAM_CHARS) {
            return Optional.of(AwkFindings.notReadable());
        }
        Optional<List<AwkToken>> tokens = lex(program);
        if (tokens.isEmpty()) {
            return Optional.of(AwkFindings.notReadable());
        }
        return Optional.of(walk(tokens.orElseThrow()));
    }

    /** True when a {@code /} after this token starts a regular expression and does not divide (AW-04). */
    private boolean regexCanStart(AwkToken previous) {
        return switch (previous.kind()) {
            case NONE -> true;
            case NUMBER, STRING, REGEX -> false;
            case WORD -> KEYWORDS.contains(previous.value());
            case PUNCT -> !NOT_BEFORE_REGEX.contains(previous.value());
            case NEWLINE -> true;
        };
    }

    /** Splits the program into tokens; empty when the program has an unterminated string or regular expression, or a line break inside one (AW-04). */
    private Optional<List<AwkToken>> lex(String source) {
        List<AwkToken> tokens = new ArrayList<>();
        int i = 0;
        int n = source.length();
        while (i < n) {
            char c = source.charAt(i);
            if (c == '\n') {
                tokens.add(AwkToken.NEWLINE);
                i++;
                continue;
            }
            if (c == ' ' || c == '\t' || c == '\r') {
                i++;
                continue;
            }
            if (c == '\\' && charAt(source, i + 1) == '\n') {
                i += 2;
                continue;
            }
            if (c == '#') {
                while (i < n && source.charAt(i) != '\n') {
                    i++;
                }
                continue;
            }
            if (c == '"') {
                StringBuilder value = new StringBuilder();
                i++;
                while (i < n && source.charAt(i) != '"') {
                    if (source.charAt(i) == '\\') {
                        if (i + 1 >= n) {
                            return Optional.empty();
                        }
                        Escape escape = readEscape(source, i + 1);
                        value.append(escape.value());
                        i += 1 + escape.consumed();
                        continue;
                    }
                    if (source.charAt(i) == '\n') {
                        return Optional.empty();
                    }
                    value.append(source.charAt(i));
                    i++;
                }
                if (i >= n) {
                    return Optional.empty();
                }
                i++;
                tokens.add(AwkToken.string(value.toString()));
                continue;
            }
            if (c == '/' && regexCanStart(tokens.isEmpty() ? AwkToken.NONE : tokens.get(tokens.size() - 1))) {
                i++;
                boolean inBracket = false;
                while (i < n) {
                    char r = source.charAt(i);
                    if (r == '\\') {
                        i += 2;
                        continue;
                    }
                    if (r == '\n') {
                        return Optional.empty();
                    }
                    if (r == '[') {
                        inBracket = true;
                    } else if (r == ']') {
                        inBracket = false;
                    } else if (r == '/' && !inBracket) {
                        break;
                    }
                    i++;
                }
                if (i >= n) {
                    return Optional.empty();
                }
                i++;
                tokens.add(AwkToken.REGEX);
                continue;
            }
            if (isDigit(c) || c == '.' && isDigit(charAt(source, i + 1))) {
                while (i < n && isNumberChar(source.charAt(i))) {
                    char x = source.charAt(i);
                    if ((x == '+' || x == '-') && !isExponent(charAt(source, i - 1))) {
                        break;
                    }
                    i++;
                }
                tokens.add(AwkToken.NUMBER);
                continue;
            }
            if (isIdentStart(c)) {
                int start = i;
                while (i < n && isIdentPart(source.charAt(i))) {
                    i++;
                }
                tokens.add(AwkToken.word(source.substring(start, i)));
                continue;
            }
            String operator = operatorAt(source, i, c);
            if (operator != null) {
                tokens.add(AwkToken.punct(operator));
                i += operator.length();
                continue;
            }
            tokens.add(AwkToken.punct(String.valueOf(c)));
            i++;
        }
        return Optional.of(tokens);
    }

    /** Walks the tokens and collects what the program runs, pipes into and writes (AW-07). */
    private AwkFindings walk(List<AwkToken> tokens) {
        List<String> commands = new ArrayList<>();
        List<String> pipedInto = new ArrayList<>();
        boolean writesFile = false;
        boolean unreadable = false;
        int depth = 0;
        int printDepth = -1;
        for (int i = 0; i < tokens.size(); i++) {
            AwkToken t = tokens.get(i);
            if (t.is(Kind.PUNCT)) {
                String v = t.value();
                if ("(".equals(v) || "[".equals(v)) {
                    depth++;
                    continue;
                }
                if (")".equals(v) || "]".equals(v)) {
                    depth--;
                    if (printDepth >= 0 && depth < printDepth) {
                        printDepth = -1;
                    }
                    continue;
                }
                if ("{".equals(v) || "}".equals(v) || ";".equals(v)) {
                    printDepth = -1;
                    continue;
                }
                if ("@".equals(v)) {
                    unreadable = true;
                    continue;
                }
                if (printDepth >= 0 && depth == printDepth) {
                    if (">".equals(v) || ">>".equals(v)) {
                        AwkToken target = tokenAt(tokens, i + 1);
                        if (!(target.is(Kind.STRING) && NON_FILE_TARGETS.contains(target.value()))) {
                            writesFile = true;
                        }
                        printDepth = -1;
                        continue;
                    }
                    if ("|".equals(v) || "|&".equals(v)) {
                        AwkToken target = tokenAt(tokens, i + 1);
                        AwkToken after = tokenAt(tokens, i + 2);
                        if (target.is(Kind.STRING) && !after.is(Kind.STRING) && !after.is(Kind.WORD)) {
                            pipedInto.add(target.value());
                        } else {
                            unreadable = true;
                        }
                        printDepth = -1;
                        continue;
                    }
                }
                if ("|".equals(v) || "|&".equals(v)) {
                    AwkToken after = tokenAt(tokens, i + 1);
                    if (after.isWord("getline")) {
                        AwkToken before = tokenAt(tokens, i - 1);
                        AwkToken earlier = tokenAt(tokens, i - 2);
                        if (before.is(Kind.STRING) && !earlier.is(Kind.STRING) && !earlier.is(Kind.WORD)) {
                            commands.add(before.value());
                        } else {
                            unreadable = true;
                        }
                    }
                }
                continue;
            }
            if (t.is(Kind.NEWLINE)) {
                printDepth = -1;
                continue;
            }
            if (t.is(Kind.WORD)) {
                if (t.isWord("print") || t.isWord("printf")) {
                    printDepth = depth;
                    continue;
                }
                if (t.isWord("system")) {
                    AwkToken open = tokenAt(tokens, i + 1);
                    if (!open.isPunct("(")) {
                        continue;
                    }
                    AwkToken argument = tokenAt(tokens, i + 2);
                    AwkToken close = tokenAt(tokens, i + 3);
                    if (argument.is(Kind.STRING) && close.isPunct(")")) {
                        commands.add(argument.value());
                    } else {
                        unreadable = true;
                    }
                }
            }
        }
        return new AwkFindings(commands, pipedInto, writesFile, unreadable);
    }

    private AwkToken tokenAt(List<AwkToken> tokens, int index) {
        return index >= 0 && index < tokens.size() ? tokens.get(index) : AwkToken.NONE;
    }

    private String operatorAt(String source, int index, char first) {
        List<String> candidates = OPERATORS_BY_FIRST.get(first);
        if (candidates == null) {
            return null;
        }
        for (String candidate : candidates) {
            if (source.startsWith(candidate, index)) {
                return candidate;
            }
        }
        return null;
    }

    /** The character at the index, or NUL when there is none; NUL matches none of the tests the lexer makes. */
    private char charAt(String source, int index) {
        return index >= 0 && index < source.length() ? source.charAt(index) : '\0';
    }

    private boolean isDigit(char c) {
        return c >= '0' && c <= '9';
    }

    /** {@code /[0-9.eExXa-fA-F+-]/}: the characters a number token runs over (a sign only after an exponent mark). */
    private boolean isNumberChar(char c) {
        return isDigit(c) || c == '.' || c == 'x' || c == 'X' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F' || c == '+' || c == '-';
    }

    private boolean isExponent(char c) {
        return c == 'e' || c == 'E';
    }

    private boolean isIdentStart(char c) {
        return c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c == '_';
    }

    private boolean isIdentPart(char c) {
        return isIdentStart(c) || isDigit(c);
    }

    private boolean isOctal(char c) {
        return c >= '0' && c <= '7';
    }

    private boolean isHex(char c) {
        return isDigit(c) || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F';
    }

    /** The escape that starts at {@code at} (the character after the backslash): octal of up to three digits, {@code \x} and up to two hex digits, a simple escape, or the character itself (AW-05). */
    private Escape readEscape(String source, int at) {
        char c = source.charAt(at);
        if (isOctal(c)) {
            StringBuilder digits = new StringBuilder().append(c);
            while (digits.length() < 3 && isOctal(charAt(source, at + digits.length()))) {
                digits.append(source.charAt(at + digits.length()));
            }
            return new Escape(String.valueOf((char) Integer.parseInt(digits.toString(), 8)), digits.length());
        }
        if (c == 'x' && isHex(charAt(source, at + 1))) {
            StringBuilder digits = new StringBuilder();
            while (digits.length() < 2 && isHex(charAt(source, at + 1 + digits.length()))) {
                digits.append(source.charAt(at + 1 + digits.length()));
            }
            return new Escape(String.valueOf((char) Integer.parseInt(digits.toString(), 16)), digits.length() + 1);
        }
        return new Escape(simpleEscape(c), 1);
    }

    private String simpleEscape(char c) {
        return switch (c) {
            case 'n' -> "\n";
            case 't' -> "\t";
            case 'r' -> "\r";
            case '\\' -> "\\";
            case '"' -> "\"";
            case '/' -> "/";
            case 'a' -> "\007";
            case 'b' -> "\b";
            case 'f' -> "\f";
            case 'v' -> "\013";
            default -> String.valueOf(c);
        };
    }

    /** The text an escape stands for and the number of source characters it used after the backslash. */
    private record Escape(String value, int consumed) {
    }
}
