package io.github.jaeseongs95.portal.domain.classify;

import io.github.jaeseongs95.portal.domain.classify.ProgramCarriers.ProgramRef;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Finds the commands that a command line starts inside itself, so that the classifier can judge each one and take the highest class (vendor {@code nestedCommands},
 * policy/classifier.js:1030-1198, rules CL-N01 to CL-N09): command and process substitutions, backticks, what an awk program runs, the program an interpreter is
 * given, find's {@code -exec} command, the segment before a pipe into an interpreter, and, when asked to, an operand that has white space in it and so may be a command.
 */
final class NestedCommands {

    /** {@code find} options that run a command (CL-N07). */
    private static final Set<String> FIND_EXEC_FLAGS = Set.of("-exec", "-execdir", "-ok", "-okdir");

    /** {@code /`([^`]*)`/g}: a backtick substitution; nesting is not read (CL-N02). */
    private static final Pattern BACKTICKS = Pattern.compile("`([^`]*)`");

    private final ShellText text;
    private final CommandTokenizer tokenizer;
    private final ProgramCarriers carriers;
    private final AwkReader awkReader;
    private final EncodedCommandDecoder decoder;

    NestedCommands(ShellText text, CommandTokenizer tokenizer, ProgramCarriers carriers, AwkReader awkReader, EncodedCommandDecoder decoder) {
        this.text = text;
        this.tokenizer = tokenizer;
        this.carriers = carriers;
        this.awkReader = awkReader;
        this.decoder = decoder;
    }

    /**
     * The inner commands of a command. With {@code speculativeOperands} an operand that has white space and that nobody read as a program is returned as a command
     * too (CL-N06): the classifier asks for it, the forbidden-command check does not.
     */
    List<String> of(String command, boolean speculativeOperands, Dialect dialect) {
        List<String> found = new ArrayList<>();
        addSubstitutions(command, found);
        Matcher backticks = BACKTICKS.matcher(command);
        while (backticks.find()) {
            found.add(backticks.group(1));
        }
        List<Segment> segments = tokenizer.segments(command, dialect);
        for (Segment segment : segments) {
            addSegmentCommands(segment.words(), speculativeOperands, found);
        }
        for (int i = 1; i < segments.size(); i++) {
            if (segments.get(i).followsPipe() && carriers.readsProgramFromStdin(segments.get(i).words())) {
                found.add(String.join(" ", segments.get(i - 1).words()));
            }
        }
        return found.stream().filter(inner -> !text.trim(inner).isEmpty()).toList();
    }

    /** {@code $(...)}, {@code <(...)}, {@code >(...)}: the text between the parentheses, counting nested ones. {@code $((} is arithmetic and is skipped; an unclosed one gives nothing (CL-N01). */
    private void addSubstitutions(String command, List<String> found) {
        int length = command.length();
        for (int i = 0; i < length; i++) {
            char c = command.charAt(i);
            boolean opensParenthesis = i + 1 < length && command.charAt(i + 1) == '(';
            boolean opensSubstitution = c == '$' && opensParenthesis;
            boolean opensProcess = (c == '<' || c == '>') && opensParenthesis;
            if (!opensSubstitution && !opensProcess) {
                continue;
            }
            if (opensSubstitution && i + 2 < length && command.charAt(i + 2) == '(') {
                continue;
            }
            int depth = 0;
            for (int j = i + 1; j < length; j++) {
                char d = command.charAt(j);
                if (d == '(') {
                    depth++;
                } else if (d == ')') {
                    depth--;
                    if (depth == 0) {
                        found.add(command.substring(i + 2, j));
                        i = j;
                        break;
                    }
                }
            }
        }
    }

    private void addSegmentCommands(List<String> words, boolean speculativeOperands, List<String> found) {
        Optional<AwkFindings> awk = awkReader.findings(words);
        awk.ifPresent(findings -> {
            found.addAll(findings.commands());
            found.addAll(findings.pipedInto());
        });
        if (!carriers.operandsAreData(words)) {
            Set<Integer> consumedOperands = new HashSet<>();
            for (int i = 0; i < words.size(); i++) {
                Optional<Interpreter> resolved = Interpreter.resolve(text.stripPath(text.unquote(words.get(i))));
                if (resolved.isEmpty()) {
                    continue;
                }
                Interpreter spec = resolved.orElseThrow();
                boolean caseInsensitive = spec.isCaseInsensitive();
                if (carriers.isFlagValue(words, i, spec.programBearingWords(), caseInsensitive)) {
                    continue;
                }
                Optional<ProgramRef> result = carriers.programAfterFlag(words, i, spec.programBearingWords(), caseInsensitive, caseInsensitive);
                if (result.isPresent()) {
                    ProgramRef reference = result.orElseThrow();
                    consumedOperands.add(reference.index());
                    found.add(reference.program());
                    if (caseInsensitive && ("-EncodedCommand".equals(reference.flag()) || "-e".equals(reference.flag()))) {
                        decoder.decode(reference.program()).ifPresent(found::add);
                    }
                }
            }
            if (speculativeOperands && awk.isEmpty()) {
                for (int i = 1; i < words.size(); i++) {
                    if (consumedOperands.contains(i) || words.get(i).startsWith("-")) {
                        continue;
                    }
                    if (text.containsSpace(words.get(i))) {
                        found.add(words.get(i));
                    }
                }
            }
        }
        for (int i = 0; i < words.size(); i++) {
            if (!FIND_EXEC_FLAGS.contains(words.get(i)) || i + 1 >= words.size()) {
                continue;
            }
            List<String> rest = words.subList(i + 1, words.size());
            int stop = indexOfTerminator(rest);
            found.add(String.join(" ", stop == -1 ? rest : rest.subList(0, stop)));
            i = stop == -1 ? words.size() : i + 1 + stop;
        }
    }

    /** The index of the first {@code +} or {@code ;} word, the end of a find command, or -1. */
    private int indexOfTerminator(List<String> words) {
        for (int i = 0; i < words.size(); i++) {
            if ("+".equals(words.get(i)) || ";".equals(words.get(i))) {
                return i;
            }
        }
        return -1;
    }
}
