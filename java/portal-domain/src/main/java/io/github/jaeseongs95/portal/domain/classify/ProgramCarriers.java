package io.github.jaeseongs95.portal.domain.classify;

import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Finds the program that an interpreter is given on a command line and judges whether the classifier can read it (vendor policy/classifier.js:1633-1910 and
 * 1972-1995, rules CL-I03 to CL-I09). A program is given after a flag ({@code sh -c 'ls'}), attached to it ({@code -c'ls'}), in a bundle of short flags
 * ({@code -xc}), as an operand ({@code deno eval 'ls'}) or on standard input ({@code echo ls | sh}).
 */
final class ProgramCarriers {

    /** Where a program was found: its text, the flag of the interpreter that introduced it and the index of the word that holds it. */
    record ProgramRef(String program, String flag, int index) {
    }

    /** The words that name standard input as the program source (CL-I08). */
    private static final Set<String> STDIN_PATHS = Set.of("-", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0");

    /** {@code /^-[A-Za-z]{2,3}$/}: a bundle of two or three short flags such as {@code -xc} or {@code -enc} (CL-I04). */
    private static final Pattern FLAG_CLUSTER = Pattern.compile("-[A-Za-z]{2,3}");

    private final ShellText text;
    private final CommandTokenizer tokenizer;
    private final LaunchPrefixes prefixes;
    private final ReaderTable readers;

    ProgramCarriers(ShellText text, CommandTokenizer tokenizer, LaunchPrefixes prefixes, ReaderTable readers) {
        this.text = text;
        this.tokenizer = tokenizer;
        this.prefixes = prefixes;
        this.readers = readers;
    }

    /** True when the segment's program is an allow-listed reader: what follows it is data, no program hides in it (CL-N04). */
    boolean operandsAreData(List<String> words) {
        int index = prefixes.effectiveCommandIndex(words);
        if (index == -1) {
            return false;
        }
        return readers.isReader(text.stripPath(text.unquote(words.get(index))));
    }

    /**
     * True when the command gives an interpreter whose language the classifier cannot read a program (CL-I03): a segment after a pipe that reads its program from
     * standard input, or an unreadable interpreter with a program flag anywhere in a segment whose program is not a reader.
     */
    boolean hasUnreadableProgram(String command, Dialect dialect) {
        for (Segment segment : tokenizer.segments(command, dialect)) {
            List<String> words = segment.words();
            if (segment.followsPipe() && readsProgramFromStdin(words)) {
                return true;
            }
            if (operandsAreData(words)) {
                continue;
            }
            for (int j = 0; j < words.size(); j++) {
                Optional<Interpreter> resolved = Interpreter.resolve(text.stripPath(text.unquote(words.get(j))));
                if (resolved.isEmpty()) {
                    continue;
                }
                Interpreter spec = resolved.orElseThrow();
                if (spec.isReadable()) {
                    continue;
                }
                boolean caseInsensitive = spec.isCaseInsensitive();
                if (isFlagValue(words, j, spec.programBearingWords(), caseInsensitive)) {
                    continue;
                }
                if (programAfterFlag(words, j, spec.programBearingWords(), caseInsensitive, caseInsensitive).isPresent()) {
                    return true;
                }
            }
        }
        return false;
    }

    /** True when the word before {@code index} is a program flag of the interpreter: this word is then its value, not an interpreter ({@code grep -e perl}) (CL-I06). */
    boolean isFlagValue(List<String> words, int index, List<String> flags, boolean caseInsensitive) {
        if (index == 0) {
            return false;
        }
        String previous = words.get(index - 1);
        if (!(previous.length() > 1 && previous.startsWith("-"))) {
            return false;
        }
        for (String flag : flags) {
            if (sameFlag(previous, flag, caseInsensitive)) {
                return true;
            }
        }
        return false;
    }

    /**
     * The program that the interpreter at {@code from} is given, scanning the words after it (CL-I04). Empty when the next word after a flag is missing, or when
     * an unknown word comes before any flag (a script name: {@code python3 script.py -c evil} has no program, {@code -c} belongs to the script). With
     * {@code tolerateUnknownWordsAtHead} the interpreter that is the segment's program also skips words it does not know (PowerShell options with a value).
     */
    Optional<ProgramRef> programAfterFlag(List<String> words, int from, List<String> flags, boolean caseInsensitive, boolean tolerateUnknownWordsAtHead) {
        boolean tolerateUnknownWords = tolerateUnknownWordsAtHead && from == prefixes.effectiveCommandIndex(words);
        for (int j = from + 1; j < words.size(); j++) {
            String word = words.get(j);
            String exact = firstSameFlag(word, flags, caseInsensitive);
            if (exact != null) {
                int k = j + 1;
                if (!exact.startsWith("-")) {
                    while (k < words.size() && skippableBetweenFlags(words.get(k))) {
                        k++;
                    }
                }
                return k < words.size() ? Optional.of(new ProgramRef(words.get(k), exact, k)) : Optional.empty();
            }
            String attached = firstAttachedFlag(word, flags);
            if (attached != null) {
                String rest = word.substring(attached.length());
                if (text.containsSpace(rest) || rest.startsWith("=")) {
                    return Optional.of(new ProgramRef(rest.startsWith("=") ? rest.substring(1) : rest, attached, j));
                }
                return nextWordAsProgram(words, j, attached);
            }
            String clusterFlag = clusterCarriesFlag(word, flags, caseInsensitive);
            if (clusterFlag != null) {
                return nextWordAsProgram(words, j, clusterFlag);
            }
            if (!skippableBetweenFlags(word) && !tolerateUnknownWords) {
                return Optional.empty();
            }
        }
        return Optional.empty();
    }

    /**
     * True when the segment's program is an interpreter that reads its program from standard input: no program flag, no script word, or {@code -s}, {@code -}, a
     * standard input path ({@code readsProgramFromStdin}, CL-I08).
     */
    boolean readsProgramFromStdin(List<String> words) {
        int index = prefixes.effectiveCommandIndex(words);
        if (index == -1) {
            return false;
        }
        Optional<Interpreter> resolved = Interpreter.resolve(text.stripPath(words.get(index)));
        if (resolved.isEmpty()) {
            return false;
        }
        List<String> flags = resolved.orElseThrow().programBearingWords();
        boolean sawStdinFlag = false;
        for (int j = index + 1; j < words.size(); j++) {
            String word = words.get(j);
            if (startsWithAny(word, flags)) {
                return false;
            }
            if ("-s".equals(word)) {
                sawStdinFlag = true;
                continue;
            }
            if ("--".equals(word)) {
                boolean hasNext = j + 1 < words.size();
                return sawStdinFlag || !hasNext || STDIN_PATHS.contains(words.get(j + 1));
            }
            if (STDIN_PATHS.contains(word)) {
                return true;
            }
            if (!word.startsWith("-")) {
                return false;
            }
        }
        return true;
    }

    private Optional<ProgramRef> nextWordAsProgram(List<String> words, int flagIndex, String flag) {
        int next = flagIndex + 1;
        return next < words.size() ? Optional.of(new ProgramRef(words.get(next), flag, next)) : Optional.empty();
    }

    private boolean startsWithAny(String word, List<String> flags) {
        for (String flag : flags) {
            if (word.startsWith(flag)) {
                return true;
            }
        }
        return false;
    }

    private String firstSameFlag(String word, List<String> flags, boolean caseInsensitive) {
        for (String flag : flags) {
            if (sameFlag(word, flag, caseInsensitive)) {
                return flag;
            }
        }
        return null;
    }

    private String firstAttachedFlag(String word, List<String> flags) {
        for (String flag : flags) {
            if (word.startsWith(flag) && word.length() > flag.length()) {
                return flag;
            }
        }
        return null;
    }

    /** The short flag (two characters) that a bundle such as {@code -xc} contains, scanning its letters in order, or null (CL-I04 item 3). */
    private String clusterCarriesFlag(String word, List<String> flags, boolean caseInsensitive) {
        if (!FLAG_CLUSTER.matcher(word).matches()) {
            return null;
        }
        String body = caseInsensitive ? word.substring(1).toLowerCase(Locale.ROOT) : word.substring(1);
        for (int n = 0; n < body.length(); n++) {
            char letter = body.charAt(n);
            for (String flag : flags) {
                if (flag.length() != 2) {
                    continue;
                }
                char flagLetter = caseInsensitive ? Character.toLowerCase(flag.charAt(1)) : flag.charAt(1);
                if (flagLetter == letter) {
                    return flag;
                }
            }
        }
        return null;
    }

    private boolean sameFlag(String word, String flag, boolean caseInsensitive) {
        return caseInsensitive ? word.toLowerCase(Locale.ROOT).equals(flag.toLowerCase(Locale.ROOT)) : word.equals(flag);
    }

    private boolean skippableBetweenFlags(String word) {
        return word.isEmpty() || word.startsWith("-");
    }
}
