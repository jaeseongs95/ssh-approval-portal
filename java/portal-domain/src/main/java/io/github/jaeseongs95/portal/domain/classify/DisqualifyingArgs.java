package io.github.jaeseongs95.portal.domain.classify;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/**
 * Arguments that make an allow-listed program write or run something, so that the command is {@code destructive} whatever the reader grammar says (vendor
 * {@code DISQUALIFYING_ARGS}, policy/classifier.js:1237-1287 and {@code hasDisqualifyingArgs} 1440-1448, rules CL-D01 and CL-D02): the {@code find} options that
 * delete, execute or write ({@code -exec}, {@code -delete}, {@code -fprint}, ...) and the {@code sort} options that write a file or run a program
 * ({@code -o}, {@code --output}, {@code --compress-program}, also in their abbreviated forms).
 */
final class DisqualifyingArgs {

    /** {@code /^-(exec|execdir|ok|okdir|delete|fprintf?|fls)$/} (CL-D01). */
    private static final Pattern FIND_ARGUMENT = Pattern.compile("-(?:exec|execdir|ok|okdir|delete|fprintf?|fls)");

    /**
     * The sort long options. A prefix of one of them selects it when exactly one of these names starts with the prefix, so the unambiguous abbreviations of
     * {@code --output} and {@code --compress-program} can be listed (CL-D02, vendor policy/classifier.js:780-804).
     */
    private static final List<String> SORT_LONG_OPTIONS = List.of("ignore-leading-blanks", "dictionary-order", "ignore-case", "general-numeric-sort",
        "ignore-nonprinting", "month-sort", "human-numeric-sort", "numeric-sort", "random-sort", "random-source", "reverse", "sort", "version-sort", "batch-size", "check",
        "compress-program", "debug", "files0-from", "key", "merge", "output", "stable", "buffer-size", "field-separator", "temporary-directory", "parallel", "unique",
        "zero-terminated", "help", "version");

    /**
     * {@code -o} alone or after short options that take no value ({@code -mo}, {@code -ofile}), or an unambiguous prefix of {@code --output} or
     * {@code --compress-program}, with or without {@code =value}. {@code -t}, {@code -k}, {@code -S} and {@code -T} are not in the bundle class because they take
     * a value, so {@code -tofile} is not an {@code -o}. The JavaScript {@code $} is {@code \z} here.
     */
    private static final Pattern SORT_ARGUMENT = Pattern.compile("^(?:" + unambiguousLongOption("compress-program") + "|" + unambiguousLongOption("output")
        + "|-[bcCdfghiMmnRrsuVz]*o)");

    /** The rule of each program, by the name a segment runs under (the path stripped, the case as written). */
    private static final Map<String, Predicate<String>> RULES = Map.of("find", argument -> FIND_ARGUMENT.matcher(argument).matches(),
        "sort", argument -> SORT_ARGUMENT.matcher(argument).find());

    private final ShellText text;
    private final CommandTokenizer tokenizer;
    private final LaunchPrefixes prefixes;

    DisqualifyingArgs(ShellText text, CommandTokenizer tokenizer, LaunchPrefixes prefixes) {
        this.text = text;
        this.tokenizer = tokenizer;
        this.prefixes = prefixes;
    }

    /** True when a segment's program (after prefixes and wrappers) is {@code find} or {@code sort} and one of its arguments is one of the listed options. */
    boolean appliesTo(String command, Dialect dialect) {
        for (List<String> words : tokenizer.wordLists(command, dialect)) {
            int index = prefixes.effectiveCommandIndex(words);
            if (index == -1) {
                continue;
            }
            String program = text.stripPath(words.get(index));
            for (String argument : words.subList(index + 1, words.size())) {
                if (disqualifies(program, argument)) {
                    return true;
                }
            }
        }
        return false;
    }

    boolean disqualifies(String program, String argument) {
        Predicate<String> rule = RULES.get(program);
        return rule != null && rule.test(argument);
    }

    /** {@code --(?:p1|p2|...)(?:=|\z)} over the prefixes of {@code full} that select it alone among the sort long options. */
    private static String unambiguousLongOption(String full) {
        List<String> prefixes = new ArrayList<>();
        for (int length = 1; length <= full.length(); length++) {
            String prefix = full.substring(0, length);
            long selected = SORT_LONG_OPTIONS.stream().filter(option -> option.startsWith(prefix)).count();
            if (selected == 1) {
                prefixes.add(prefix);
            }
        }
        return "--(?:" + String.join("|", prefixes) + ")(?:=|\\z)";
    }
}
