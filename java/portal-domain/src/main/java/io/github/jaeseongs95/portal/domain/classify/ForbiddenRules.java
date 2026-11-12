package io.github.jaeseongs95.portal.domain.classify;

import io.github.jaeseongs95.portal.domain.classify.LaunchPrefixes.ParsedSegment;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/**
 * The commands the classifier calls {@code destructive} by name or shape (vendor {@code FORBIDDEN_RULES} and {@code isDestructive}, policy/classifier.js:621-660 and
 * 1449-1593, rules CL-F01 to CL-F15): nine regular expressions that are tried on the raw command and on its normalized form, four rules on words (a power-state
 * command or {@code eval}, a download piped into a shell, {@code dd} onto a block device, {@code chown -R /}), the recursive removal of anything under the root, and
 * all of these again on every inner command up to the nesting depth. The vendor's word based rules replaced a regular expression that took a minute on a 1 MiB
 * input (policy/classifier.js:597-619); they are not merged back.
 */
final class ForbiddenRules {

    /** The recursive remove flags: {@code -r}, {@code -R}, {@code -rf}, {@code -Rf}, {@code -fr}, {@code -fR}. */
    private static final String RM_RECURSIVE_FLAGS = "-(?:[rR]f?|f[rR])";

    /**
     * The nine patterns, all unanchored searches. CL-F01 and CL-F14 differ from the vendor in the flags: the vendor's {@code -rf?} misses {@code rm -fr /},
     * {@code -R} and {@code -Rf} (intended behavior change, VR-041). {@code \s} is the ECMAScript white space, {@code \b} is an ASCII word boundary and the
     * JavaScript {@code .} is {@code ANY_CHAR}.
     */
    private static final List<Pattern> FORBIDDEN_PATTERNS = List.of(
        Pattern.compile("rm" + ShellText.SPACE + "+" + RM_RECURSIVE_FLAGS + ShellText.SPACE + "+/(?:" + ShellText.SPACE + "|\\z)"),
        Pattern.compile("mkfs\\."),
        Pattern.compile(">" + ShellText.SPACE + "*/dev/sd"),
        Pattern.compile(":" + ShellText.SPACE + "*\\(" + ShellText.SPACE + "*\\)" + ShellText.SPACE + "*\\{" + ShellText.SPACE + "*:" + ShellText.SPACE + "*\\|"
            + ShellText.SPACE + "*:" + ShellText.SPACE + "*&" + ShellText.SPACE + "*\\}" + ShellText.SPACE + "*;" + ShellText.SPACE + "*:"),
        Pattern.compile(">" + ShellText.SPACE + "*/etc/cron"),
        Pattern.compile(">" + ShellText.SPACE + "*/etc/systemd"),
        Pattern.compile(">" + ShellText.SPACE + "*~/" + ShellText.ANY_CHAR + "ssh/authorized_keys"),
        Pattern.compile(ShellText.NO_WORD_BEFORE + "iptables" + ShellText.SPACE + "+-F" + ShellText.NO_WORD_AFTER),
        Pattern.compile(ShellText.NO_WORD_BEFORE + "chmod" + ShellText.SPACE + "+-R" + ShellText.SPACE + "+777" + ShellText.SPACE + "+/"));

    /** CL-F14: removing anything under the root recursively is destructive, not only the root itself. */
    private static final Pattern DESTRUCTIVE_PATTERN = Pattern.compile("rm" + ShellText.SPACE + "+" + RM_RECURSIVE_FLAGS + ShellText.SPACE + "+/");

    /** The power-state commands and {@code eval} (CL-F10). */
    private static final Set<String> FORBIDDEN_INVOCATIONS = Set.of("shutdown", "reboot", "halt", "poweroff", "eval");

    /** Programs whose action is the first word that does not start with a hyphen: {@code systemctl reboot} (CL-F10). */
    private static final Set<String> ACTION_MULTIPLEXERS = Set.of("systemctl", "init", "telinit");

    private static final Set<String> SHELLS = Set.of("sh", "bash", "zsh");

    private static final Set<String> DOWNLOADERS = Set.of("curl", "wget");

    /** An inner command is read this deep and no deeper; the vendor does not call that a match (CL-F15). */
    private static final int MAX_NESTING_DEPTH = 8;

    private final ShellText text;
    private final CommandTokenizer tokenizer;
    private final LaunchPrefixes prefixes;
    private final NestedCommands nestedCommands;

    ForbiddenRules(ShellText text, CommandTokenizer tokenizer, LaunchPrefixes prefixes, NestedCommands nestedCommands) {
        this.text = text;
        this.tokenizer = tokenizer;
        this.prefixes = prefixes;
        this.nestedCommands = nestedCommands;
    }

    /** True for a forbidden command or for a recursive removal under the root (vendor {@code isDestructive}). */
    boolean isDestructive(String command, Dialect dialect) {
        return isForbidden(command, 0, dialect) || matchesEitherForm(command, DESTRUCTIVE_PATTERN.asPredicate(), dialect);
    }

    /** True when a forbidden rule matches the command or, up to the nesting depth, one of its inner commands. */
    boolean isForbidden(String command, int depth, Dialect dialect) {
        if (matchesEitherForm(command, form -> FORBIDDEN_PATTERNS.stream().anyMatch(pattern -> pattern.matcher(form).find()), dialect)
            || invokesPowerStateCommand(command, dialect) || pipesDownloadIntoShell(command, dialect) || writesToDevice(command, dialect) || chownsRoot(command, dialect)) {
            return true;
        }
        if (depth >= MAX_NESTING_DEPTH) {
            return false;
        }
        for (String inner : nestedCommands.of(command, false, dialect)) {
            if (isForbidden(inner, depth + 1, dialect)) {
                return true;
            }
        }
        return false;
    }

    /** Tests the raw command and its normalized form (CL-T08): a quoted word that holds a separator cannot join its neighbours into a match, and a quoted word that is a path can still match. */
    private boolean matchesEitherForm(String command, Predicate<String> test, Dialect dialect) {
        return test.test(command) || test.test(tokenizer.normalized(command, dialect));
    }

    /** A segment's program, or the action of a multiplexer ({@code systemctl reboot}), is a power-state command or {@code eval} (CL-F10). */
    private boolean invokesPowerStateCommand(String command, Dialect dialect) {
        for (ParsedSegment segment : prefixes.parseSegments(command, dialect)) {
            if (FORBIDDEN_INVOCATIONS.contains(segment.head())) {
                return true;
            }
            if (ACTION_MULTIPLEXERS.contains(segment.head())) {
                for (String argument : segment.args()) {
                    if (!argument.startsWith("-") && FORBIDDEN_INVOCATIONS.contains(text.stripPath(argument))) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    /**
     * The programs of the first segment and of every segment after a pipe: a downloader somewhere before a shell (CL-F11). A segment that has no program counts as
     * the empty string, which is neither a downloader nor a shell.
     */
    private boolean pipesDownloadIntoShell(String command, Dialect dialect) {
        List<Segment> segments = tokenizer.segments(command, dialect);
        boolean downloaded = false;
        for (int i = 0; i < segments.size(); i++) {
            if (i != 0 && !segments.get(i).followsPipe()) {
                continue;
            }
            String head = prefixes.parseWords(segments.get(i).words()).map(ParsedSegment::head).orElse("");
            if (downloaded && SHELLS.contains(head)) {
                return true;
            }
            if (DOWNLOADERS.contains(head)) {
                downloaded = true;
            }
        }
        return false;
    }

    /** {@code dd} with an {@code of=/dev/...} argument (CL-F12). */
    private boolean writesToDevice(String command, Dialect dialect) {
        for (ParsedSegment segment : prefixes.parseSegments(command, dialect)) {
            if ("dd".equals(segment.head()) && segment.args().stream().anyMatch(argument -> argument.startsWith("of=/dev/"))) {
                return true;
            }
        }
        return false;
    }

    /** {@code chown} with exactly the word {@code -R} and {@code /} as its last argument that is not an option (CL-F13). */
    private boolean chownsRoot(String command, Dialect dialect) {
        for (ParsedSegment segment : prefixes.parseSegments(command, dialect)) {
            if (!"chown".equals(segment.head()) || !segment.args().contains("-R")) {
                continue;
            }
            String last = null;
            for (String argument : segment.args()) {
                if (!argument.startsWith("-")) {
                    last = argument;
                }
            }
            if ("/".equals(last)) {
                return true;
            }
        }
        return false;
    }
}
