package io.github.jaeseongs95.portal.domain.classify;

import io.github.jaeseongs95.portal.domain.text.CommandText;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The classifier of ssh-mcp 2.18.0 ({@code classifyCommand}, policy/classifier.js:2074-2201) ported to Java, with the same classes for the same command lines
 * except where the notes of the rule classes name an intended change. Rules CL-A01 to CL-A08 of docs/migration/vendor-ssh-mcp-rules.md are in this class; the
 * rest are in the rule objects it is assembled from, none of which has state, so one instance serves every thread.
 * <p>
 * A command is read in the POSIX dialect; one with a backslash is read in the Windows dialect as well and the higher class wins. In one dialect the first rule that
 * applies decides the outer command: a privilege prefix makes it {@code privileged}; a program the classifier cannot read, an awk program that writes, a forbidden
 * or recursive-remove command or a find/sort option that writes make it {@code destructive}; a command name with {@code $} or a backtick is {@code destructive};
 * an allow-listed reader is {@code read-only} when no shell control character is in the text and its grammar accepts its arguments; every other command is
 * {@code safe}. The inner commands (substitutions, interpreter programs, ...) are classified the same way one level deeper and only a strictly higher class
 * replaces the outer one. At the eighth level the answer is {@code privileged} without reading further.
 */
public final class VendorCommandClassifier implements CommandClassifier {

    /** An inner command is classified up to this depth; deeper than that is {@code privileged} (CL-A05). */
    private static final int MAX_NESTING_DEPTH = 8;

    /**
     * Every character with a meaning for the shell, so that an allow-listed program can start nothing beside itself: {@code ; & | < > ` $ ( ) { }} and the two line
     * break characters. The backslash is not one of them (CL-G01).
     */
    private static final String SHELL_CONTROL_CHARACTERS = ";&|<>`$(){}\n\r";

    /** Synthetic verbs of the tool layer that are read-only without looking at their arguments (CL-S01). */
    private static final Set<String> READ_ONLY_SYNTHETIC = Set.of("sftp:list", "sftp:download");

    /** The least class of a synthetic verb; the class is raised to it and never lowered ({@code session:close} has none) (CL-S02). */
    private static final Map<String, CommandClass> SYNTHETIC_FLOORS = Map.of("sftp:upload", CommandClass.DESTRUCTIVE, "sftp:upload-file", CommandClass.DESTRUCTIVE,
        "sftp:download-file", CommandClass.DESTRUCTIVE, "session:open", CommandClass.DESTRUCTIVE);

    /** The privilege prefixes {@code extractBinary} removes, in this order, each once (CL-A08). {@code \b} is an ASCII word boundary. */
    private static final List<Pattern> LEADING_PRIVILEGE_PREFIXES = List.of(
        Pattern.compile("^" + ShellText.SPACE + "*sudo" + ShellText.NO_WORD_AFTER),
        Pattern.compile("^" + ShellText.SPACE + "*su" + ShellText.NO_WORD_AFTER),
        Pattern.compile("^" + ShellText.SPACE + "*doas" + ShellText.NO_WORD_AFTER),
        Pattern.compile("^" + ShellText.SPACE + "*pkexec" + ShellText.NO_WORD_AFTER));

    private final ShellText text;
    private final CommandTokenizer tokenizer;
    private final LaunchPrefixes prefixes;
    private final ReaderTable readers;
    private final ProgramCarriers carriers;
    private final AwkReader awkReader;
    private final ForbiddenRules forbiddenRules;
    private final DisqualifyingArgs disqualifyingArgs;
    private final NestedCommands nestedCommands;

    public VendorCommandClassifier() {
        this.text = new ShellText();
        this.tokenizer = new CommandTokenizer(text);
        this.prefixes = new LaunchPrefixes(text, tokenizer);
        this.readers = new ReaderTable();
        this.carriers = new ProgramCarriers(text, tokenizer, prefixes, readers);
        this.awkReader = new AwkReader(text, tokenizer, prefixes, carriers);
        this.nestedCommands = new NestedCommands(text, tokenizer, carriers, awkReader, new EncodedCommandDecoder(text));
        this.forbiddenRules = new ForbiddenRules(text, tokenizer, prefixes, nestedCommands);
        this.disqualifyingArgs = new DisqualifyingArgs(text, tokenizer, prefixes);
    }

    @Override
    public CommandClassification classify(CommandText command) {
        return classifyText(command.value());
    }

    /**
     * Classifies any string, valid command text or not. {@link CommandText} is what the product passes; this is for the vendor cases that the text type refuses (the
     * empty string, a 262145 character awk program).
     */
    CommandClassification classifyText(String command) {
        String trimmed = text.trim(command);
        Verdict posix = classifyInDialect(command, 0, Dialect.POSIX);
        Verdict chosen = posix;
        if (command.indexOf('\\') >= 0) {
            Verdict windows = classifyInDialect(command, 0, Dialect.WINDOWS);
            chosen = windows.commandClass().isHigherThan(posix.commandClass()) ? windows : posix;
        }
        return new CommandClassification(chosen.commandClass(), chosen.binary(), trimmed, chosen.rejection());
    }

    /** What one dialect decided; the rejection is null when there is none. */
    private record Verdict(CommandClass commandClass, String binary, ReadOnlyRejection rejection) {
    }

    private Verdict classifyInDialect(String command, int depth, Dialect dialect) {
        String trimmed = text.trim(command);
        Verdict outer = classifyOuter(trimmed, dialect);
        if (depth >= MAX_NESTING_DEPTH) {
            return new Verdict(CommandClass.PRIVILEGED, outer.binary(), null);
        }
        Verdict highest = outer;
        String verb = syntheticVerb(trimmed, dialect);
        CommandClass floor = SYNTHETIC_FLOORS.get(verb);
        if (floor != null && floor.isHigherThan(highest.commandClass())) {
            highest = new Verdict(floor, verb, null);
        }
        for (String inner : nestedCommands.of(trimmed, true, dialect)) {
            Verdict parsed = classifyInDialect(inner, depth + 1, dialect);
            if (parsed.commandClass().isHigherThan(highest.commandClass())) {
                highest = parsed;
            }
        }
        // The rejection explains the verdict of the outer command; it is kept only when the outer command is the one that decided (CL-A06).
        return new Verdict(highest.commandClass(), highest.binary(), highest == outer ? outer.rejection() : null);
    }

    private Verdict classifyOuter(String trimmed, Dialect dialect) {
        String binary = extractBinary(trimmed, dialect);
        Optional<String> elevated = prefixes.elevatedBinaryOf(trimmed, dialect);
        if (elevated.isPresent()) {
            return new Verdict(CommandClass.PRIVILEGED, elevated.orElseThrow(), null);
        }
        if (carriers.hasUnreadableProgram(trimmed, dialect) || awkReader.hasDangerousAwk(trimmed, dialect) || forbiddenRules.isDestructive(trimmed, dialect)
            || disqualifyingArgs.appliesTo(trimmed, dialect)) {
            return new Verdict(CommandClass.DESTRUCTIVE, binary, null);
        }
        if (hasUnnameableCommand(trimmed, dialect)) {
            return new Verdict(CommandClass.DESTRUCTIVE, binary, null);
        }
        List<String> words = firstSegmentWords(trimmed, dialect);
        String twoWordPrefix = String.join(" ", words.subList(0, Math.min(2, words.size())));
        boolean matchedTwoWord = readers.isReader(twoWordPrefix);
        if (readers.isReader(binary) || matchedTwoWord || READ_ONLY_SYNTHETIC.contains(binary)) {
            if (hasShellControlCharacter(trimmed)) {
                return new Verdict(CommandClass.SAFE, binary, null);
            }
            if (READ_ONLY_SYNTHETIC.contains(binary)) {
                return new Verdict(CommandClass.READ_ONLY, binary, null);
            }
            int argumentStart = Math.min(matchedTwoWord ? 2 : 1, words.size());
            return classifyReader(trimmed, dialect, binary, matchedTwoWord ? twoWordPrefix : binary, words.subList(argumentStart, words.size()));
        }
        return new Verdict(CommandClass.SAFE, binary, null);
    }

    /** An allow-listed reader without shell control characters: {@code read-only} when no unquoted glob word and no word the grammar refuses is there (CL-G03, CL-G04). */
    private Verdict classifyReader(String trimmed, Dialect dialect, String binary, String readerName, List<String> argumentWords) {
        Optional<ReaderGrammar> found = readers.grammar(readerName);
        if (found.isEmpty()) {
            return new Verdict(CommandClass.SAFE, binary, null);
        }
        ReaderGrammar grammar = found.orElseThrow();
        if (grammar.style() != ReaderGrammar.Style.ANY) {
            Optional<String> globWord = tokenizer.firstUnquotedGlobWord(trimmed, true, dialect);
            if (globWord.isPresent()) {
                return new Verdict(CommandClass.SAFE, binary, new ReadOnlyRejection(readerName, globWord.orElseThrow()));
            }
        }
        GrammarMatch match = grammar.match(argumentWords);
        if (!match.accepted()) {
            return new Verdict(CommandClass.SAFE, binary, new ReadOnlyRejection(readerName, match.word()));
        }
        return new Verdict(CommandClass.READ_ONLY, binary, null);
    }

    /**
     * The program a command line is about, used as the allow-list key (CL-A08, {@code extractBinary}): the words of the first segment joined by a space, the
     * leading {@code sudo}, {@code su}, {@code doas}, {@code pkexec} removed once each in this order, a leading {@code -c } cut, then the text up to the first white
     * space. A path or a different case is not normalized: {@code /bin/ls} and {@code LS} are not {@code ls}.
     */
    private String extractBinary(String command, Dialect dialect) {
        String joined = text.trim(String.join(" ", firstSegmentWords(command, dialect)));
        for (Pattern prefix : LEADING_PRIVILEGE_PREFIXES) {
            joined = text.trim(prefix.matcher(joined).replaceFirst(""));
        }
        if (joined.startsWith("-c ")) {
            joined = text.trim(joined.substring(3));
        }
        return text.firstToken(joined);
    }

    private List<String> firstSegmentWords(String command, Dialect dialect) {
        List<Segment> segments = tokenizer.segments(command, dialect);
        return segments.isEmpty() ? List.of() : segments.get(0).words();
    }

    /** The first word of the first segment, the verb of a tool layer command text such as {@code sftp:upload ...}; empty for an empty command. */
    private String syntheticVerb(String command, Dialect dialect) {
        List<String> words = firstSegmentWords(command, dialect);
        return words.isEmpty() ? "" : words.get(0);
    }

    /** True when a segment's program word has {@code $} or a backtick: the command name is only known to the shell (CL-U01). */
    private boolean hasUnnameableCommand(String command, Dialect dialect) {
        for (List<String> words : tokenizer.wordLists(command, dialect)) {
            int index = prefixes.effectiveCommandIndex(words);
            if (index == -1) {
                continue;
            }
            String head = words.get(index);
            if (head.indexOf('$') >= 0 || head.indexOf('`') >= 0) {
                return true;
            }
        }
        return false;
    }

    /** {@code /[;&|<>`$(){}\n\r]/} on the raw text, so a character inside quotes counts too (CL-G01). */
    private boolean hasShellControlCharacter(String command) {
        for (int i = 0; i < command.length(); i++) {
            if (SHELL_CONTROL_CHARACTERS.indexOf(command.charAt(i)) >= 0) {
                return true;
            }
        }
        return false;
    }
}
