package io.github.jaeseongs95.portal.domain.classify;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Which argument words an allow-listed reader accepts and still counts as {@code read-only} (vendor {@code matchesGrammar}, policy/reader-grammar.js, rules
 * RG-01 to RG-12). {@link Style#ANY} accepts every word; {@link Style#GETOPT} reads short option clusters, {@code --name=value} and {@code --}; {@link Style#EXACT}
 * takes every word that starts with a hyphen as one whole option name. An option the lists do not name is rejected, a name that two lists name is rejected.
 */
record ReaderGrammar(Style style, Set<String> flags, Set<String> valueFlags, Set<String> optionalValueFlags, boolean numericShort, boolean optionsBeforeOperands,
    OperandRules operands) {

    enum Style {
        /** Every word is accepted; the allow-list entry vouches for the program. */
        ANY,
        /** GNU-style options. */
        GETOPT,
        /** Whole-word options only. */
        EXACT
    }

    ReaderGrammar {
        flags = Set.copyOf(flags);
        valueFlags = Set.copyOf(valueFlags);
        optionalValueFlags = Set.copyOf(optionalValueFlags);
    }

    static ReaderGrammar any() {
        return new ReaderGrammar(Style.ANY, Set.of(), Set.of(), Set.of(), false, false, OperandRules.NONE);
    }

    static ReaderGrammar getopt(List<String> flags) {
        return new ReaderGrammar(Style.GETOPT, Set.copyOf(flags), Set.of(), Set.of(), false, false, OperandRules.NONE);
    }

    static ReaderGrammar exact(List<String> flags) {
        return new ReaderGrammar(Style.EXACT, Set.copyOf(flags), Set.of(), Set.of(), false, false, OperandRules.NONE);
    }

    ReaderGrammar withValueFlags(List<String> names) {
        return new ReaderGrammar(style, flags, Set.copyOf(names), optionalValueFlags, numericShort, optionsBeforeOperands, operands);
    }

    ReaderGrammar withOptionalValueFlags(List<String> names) {
        return new ReaderGrammar(style, flags, valueFlags, Set.copyOf(names), numericShort, optionsBeforeOperands, operands);
    }

    ReaderGrammar withNumericShort() {
        return new ReaderGrammar(style, flags, valueFlags, optionalValueFlags, true, optionsBeforeOperands, operands);
    }

    ReaderGrammar withOptionsBeforeOperands() {
        return new ReaderGrammar(style, flags, valueFlags, optionalValueFlags, numericShort, true, operands);
    }

    ReaderGrammar withOperands(OperandRules rules) {
        return new ReaderGrammar(style, flags, valueFlags, optionalValueFlags, numericShort, optionsBeforeOperands, rules);
    }

    /** Whether the argument words (the words after the program name) stay within the grammar. */
    GrammarMatch match(List<String> words) {
        if (style == Style.ANY) {
            return GrammarMatch.ACCEPTED;
        }
        List<String> operandWords = new ArrayList<>();
        boolean optionsEnded = false;
        for (int i = 0; i < words.size(); i++) {
            String word = words.get(i);
            boolean looksLikeOption = !optionsEnded && word.length() > 1 && word.startsWith("-");
            if (optionsBeforeOperands && !operandWords.isEmpty() && looksLikeOption) {
                return GrammarMatch.rejectedAt(word);
            }
            if (style == Style.GETOPT && !optionsEnded && "--".equals(word)) {
                optionsEnded = true;
                continue;
            }
            if (!looksLikeOption) {
                operandWords.add(word);
                continue;
            }
            if (style == Style.GETOPT && numericShort && isNegativeNumber(word)) {
                String shortChar = word.substring(0, 2);
                if (isAmbiguous(word) || isAmbiguous(shortChar)) {
                    return GrammarMatch.rejectedAt(word);
                }
                boolean explicitlyListed = isListed(word) || isListed(shortChar);
                if (!explicitlyListed) {
                    continue;
                }
            }
            if (style == Style.GETOPT && !word.startsWith("--")) {
                Cluster cluster = matchShortCluster(word, words, i);
                if (!cluster.accepted()) {
                    return GrammarMatch.rejectedAt(cluster.word());
                }
                i = cluster.nextIndex();
                continue;
            }
            int equalsAt = style == Style.GETOPT ? word.indexOf('=') : -1;
            String name = equalsAt == -1 ? word : word.substring(0, equalsAt);
            if (isAmbiguous(name)) {
                return GrammarMatch.rejectedAt(word);
            }
            if (valueFlags.contains(name)) {
                if (equalsAt != -1) {
                    continue;
                }
                if (i + 1 >= words.size()) {
                    return GrammarMatch.rejectedAt(name);
                }
                i++;
                continue;
            }
            if (optionalValueFlags.contains(name)) {
                continue;
            }
            if (flags.contains(name) && equalsAt == -1) {
                continue;
            }
            return GrammarMatch.rejectedAt(word);
        }
        return operands.check(operandWords);
    }

    /** {@code /^-\d+$/} with ASCII digits: a hyphen and digits and nothing else. */
    private boolean isNegativeNumber(String word) {
        if (word.length() < 2 || word.charAt(0) != '-') {
            return false;
        }
        for (int i = 1; i < word.length(); i++) {
            char c = word.charAt(i);
            if (c < '0' || c > '9') {
                return false;
            }
        }
        return true;
    }

    private boolean isListed(String name) {
        return flags.contains(name) || valueFlags.contains(name) || optionalValueFlags.contains(name);
    }

    /** A name that two of the three lists name has no one meaning (RG-08). */
    private boolean isAmbiguous(String name) {
        boolean inFlags = flags.contains(name);
        boolean inValueFlags = valueFlags.contains(name);
        boolean inOptionalValueFlags = optionalValueFlags.contains(name);
        return inFlags && inValueFlags || inFlags && inOptionalValueFlags || inValueFlags && inOptionalValueFlags;
    }

    /** A bundle of short options such as {@code -rn} or {@code -k2,2}: each letter is read as {@code -letter} (RG-07). */
    private Cluster matchShortCluster(String word, List<String> words, int index) {
        for (int c = 1; c < word.length(); c++) {
            String option = "-" + word.charAt(c);
            if (isAmbiguous(option)) {
                return Cluster.rejectedAt(word);
            }
            if (flags.contains(option)) {
                continue;
            }
            if (valueFlags.contains(option)) {
                String rest = word.substring(c + 1);
                if (!rest.isEmpty()) {
                    return Cluster.consumedUpTo(index);
                }
                if (index + 1 >= words.size()) {
                    return Cluster.rejectedAt(option);
                }
                return Cluster.consumedUpTo(index + 1);
            }
            if (optionalValueFlags.contains(option)) {
                return Cluster.consumedUpTo(index);
            }
            return Cluster.rejectedAt(word);
        }
        return Cluster.consumedUpTo(index);
    }

    /** The result of reading one short option bundle: accepted (with the index of the last word it used) or rejected at a word. */
    private record Cluster(boolean accepted, String word, int nextIndex) {

        static Cluster consumedUpTo(int nextIndex) {
            return new Cluster(true, "", nextIndex);
        }

        static Cluster rejectedAt(String word) {
            return new Cluster(false, word, -1);
        }
    }
}
