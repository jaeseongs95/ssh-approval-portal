package io.github.jaeseongs95.portal.domain.classify;

import java.util.List;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/**
 * What a grammar demands of the words that are not options (vendor {@code operands: {max, first, each}}, policy/reader-grammar.js:210-246): at most {@code max}
 * of them, the first one is in {@code first} (when that list is not empty), and every one satisfies {@code each}. A negative {@code max} is not a valid limit and
 * counts as zero, as a {@code max} that is not a non-negative integer does in the vendor engine.
 */
record OperandRules(int max, List<String> first, Predicate<String> each) {

    static final int UNLIMITED = Integer.MAX_VALUE;

    /** No demand at all. */
    static final OperandRules NONE = new OperandRules(UNLIMITED, List.of(), operand -> true);

    OperandRules {
        first = List.copyOf(first);
    }

    static OperandRules atMost(int max) {
        return new OperandRules(max, List.of(), operand -> true);
    }

    static OperandRules firstIsOneOf(List<String> first) {
        return new OperandRules(UNLIMITED, first, operand -> true);
    }

    static OperandRules atMostWithFirst(int max, List<String> first) {
        return new OperandRules(max, first, operand -> true);
    }

    /** Every operand has a match of {@code each} ({@code RegExp.test}: a match anywhere, the pattern anchors itself). */
    static OperandRules matching(Pattern each, int max) {
        return new OperandRules(max, List.of(), each.asPredicate());
    }

    GrammarMatch check(List<String> operands) {
        for (int i = 0; i < operands.size(); i++) {
            String operand = operands.get(i);
            if (i == 0 && !first.isEmpty() && !first.contains(operand)) {
                return GrammarMatch.rejectedAt(operand);
            }
            if (!each.test(operand)) {
                return GrammarMatch.rejectedAt(operand);
            }
        }
        int limit = max >= 0 ? max : 0;
        if (operands.size() > limit) {
            return GrammarMatch.rejectedAt(operands.get(limit));
        }
        return GrammarMatch.ACCEPTED;
    }
}
