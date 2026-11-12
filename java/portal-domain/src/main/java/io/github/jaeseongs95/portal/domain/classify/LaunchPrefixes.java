package io.github.jaeseongs95.portal.domain.classify;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The words in front of the program a segment really runs: privilege prefixes ({@code sudo}, {@code doas}, ...), execution wrappers ({@code env},
 * {@code timeout}, ...), variable assignments, options and bare numbers (vendor policy/classifier.js:1200-1401, rules CL-P01 to CL-P05, CL-I09). Which program a
 * segment runs and whether a privilege prefix leads to it are decided here.
 */
final class LaunchPrefixes {

    /** The program a segment runs after its privilege prefixes, with the words that follow it. */
    record ParsedSegment(String head, List<String> args) {
    }

    /** Exactly these 11 names; {@code sudoedit} is not one of them (CL-P01). */
    private static final Set<String> PRIVILEGE_PREFIXES = Set.of("sudo", "su", "doas", "pkexec", "su-exec", "gosu", "sudo-rs", "run0", "pfexec", "runuser", "setpriv");

    /** Wrappers that run what follows them (CL-P02). */
    private static final Set<String> EXEC_WRAPPERS = Set.of("env", "nohup", "nice", "ionice", "command", "exec", "setsid", "stdbuf", "timeout", "chrt", "taskset", "xargs",
        "watch", "busybox");

    /** Options of a prefix that take the next word as their value (CL-P03). */
    private static final Set<String> PREFIX_VALUE_FLAGS = Set.of("-u", "-g", "-p", "-C", "-h", "-r", "-t", "-U", "-c", "--user", "--group", "--prompt", "--close-from",
        "--host", "--role", "--type", "--other-user", "--command");

    /** {@code /^[A-Za-z_][A-Za-z0-9_]*=/}: a variable assignment in front of a command (CL-P04). */
    private static final Pattern ASSIGNMENT = Pattern.compile("[A-Za-z_][A-Za-z0-9_]*=");

    /** {@code /^\d+(\.\d+)?[smhd]?$/}: a duration such as {@code 5} or {@code 1.5s}, the first argument of {@code timeout} (CL-P04). */
    private static final Pattern BARE_NUMERIC = Pattern.compile("\\d+(?:\\.\\d+)?[smhd]?");

    private final ShellText text;
    private final CommandTokenizer tokenizer;

    LaunchPrefixes(ShellText text, CommandTokenizer tokenizer) {
        this.text = text;
        this.tokenizer = tokenizer;
    }

    /**
     * The index of the word the segment runs, or -1 when there is none: privilege prefixes and wrappers (with their options) are skipped, then assignments,
     * words that start with a hyphen and bare numbers ({@code effectiveCommandIndex}, CL-I09).
     */
    int effectiveCommandIndex(List<String> words) {
        int i = 0;
        while (i < words.size()) {
            String raw = words.get(i);
            String word = text.stripPath(text.unquote(raw));
            if (PRIVILEGE_PREFIXES.contains(word) || EXEC_WRAPPERS.contains(word)) {
                i = skipPrefixOptions(words, i + 1);
                continue;
            }
            if (ASSIGNMENT.matcher(raw).lookingAt() || raw.startsWith("-") || BARE_NUMERIC.matcher(raw).matches()) {
                i++;
                continue;
            }
            return i;
        }
        return -1;
    }

    /**
     * The program a privilege prefix leads to in the first segment that has one ({@code elevatedBinaryOf}, CL-P05): empty when no segment runs under a prefix,
     * the program's name otherwise, the prefix's own name when nothing follows the prefix.
     */
    Optional<String> elevatedBinaryOf(String command, Dialect dialect) {
        for (List<String> words : tokenizer.wordLists(command, dialect)) {
            Optional<String> found = elevatedBinary(words);
            if (found.isPresent()) {
                return found;
            }
        }
        return Optional.empty();
    }

    /** The program of each segment (privilege prefixes skipped, no wrapper skipped) and the words after it ({@code parseSegments}). */
    List<ParsedSegment> parseSegments(String command, Dialect dialect) {
        List<ParsedSegment> segments = new ArrayList<>();
        for (List<String> words : tokenizer.wordLists(command, dialect)) {
            parseWords(words).ifPresent(segments::add);
        }
        return segments;
    }

    Optional<ParsedSegment> parseWords(List<String> words) {
        int i = 0;
        while (i < words.size() && PRIVILEGE_PREFIXES.contains(text.stripPath(words.get(i)))) {
            i = skipPrefixOptions(words, i + 1);
        }
        if (i < words.size()) {
            return Optional.of(new ParsedSegment(text.stripPath(words.get(i)), words.subList(i + 1, words.size())));
        }
        return Optional.empty();
    }

    private Optional<String> elevatedBinary(List<String> words) {
        int i = 0;
        String prefix = null;
        while (i < words.size()) {
            String raw = words.get(i);
            String word = text.stripPath(text.unquote(raw));
            if (PRIVILEGE_PREFIXES.contains(word)) {
                if (prefix == null) {
                    prefix = word;
                }
                i = skipPrefixOptions(words, i + 1);
                continue;
            }
            if (ASSIGNMENT.matcher(raw).lookingAt() || EXEC_WRAPPERS.contains(word) || raw.startsWith("-") || BARE_NUMERIC.matcher(raw).matches()) {
                i++;
                continue;
            }
            return prefix == null ? Optional.empty() : Optional.of(word);
        }
        return Optional.ofNullable(prefix);
    }

    /** From {@code from}, skips the words that start with a hyphen; an option that takes a value also skips its value. Returns the index of the first word not skipped. */
    private int skipPrefixOptions(List<String> words, int from) {
        int i = from;
        while (i < words.size() && words.get(i).startsWith("-")) {
            boolean consumesValue = PREFIX_VALUE_FLAGS.contains(words.get(i));
            i++;
            if (consumesValue) {
                i++;
            }
        }
        return i;
    }
}
