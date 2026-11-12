package io.github.jaeseongs95.portal.domain.command;

import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import io.github.jaeseongs95.portal.domain.target.Toggle;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * What the owner allowed for one target: which command names run without asking, which are never run, whether the command may be shown to a model evaluator,
 * whether a model answer may approve and the thresholds for that, and the switches for sudo, file transfer, source code and the test server
 * (command-policy.mjs:43-71). A rule belongs to one target at one revision and one profile; a rule written for another revision of the target does not apply.
 *
 * <p>A switch that 2.x left out of a stored rule is {@link Toggle#OFF}; the rule never has an "unknown" switch.
 */
public record TargetRule(TargetId targetId, TargetRevision targetRevision, ProfileAlias profile, TargetOs os, CommandNames commands, CommandNames deniedCommands,
                         Toggle externalDisclosure, Toggle modelExecution, Toggle automaticUploads, Toggle automaticDownloads, Toggle automaticSudo, Toggle testServer,
                         SourceContract sourceExecutionContract, Fallback fallback, Thresholds thresholds) {

    private static final String SUDO = "sudo";
    /** What splits a command line into the words a denied name is looked for in (command-policy.mjs:98): everything that cannot be part of a program name. */
    private static final Pattern NOT_A_NAME_CHARACTER = Pattern.compile("[^A-Za-z0-9_.+-]+");

    public TargetRule {
        Objects.requireNonNull(targetId, "targetId");
        Objects.requireNonNull(targetRevision, "targetRevision");
        Objects.requireNonNull(profile, "profile");
        Objects.requireNonNull(os, "os");
        Objects.requireNonNull(commands, "commands");
        Objects.requireNonNull(deniedCommands, "deniedCommands");
        Objects.requireNonNull(externalDisclosure, "externalDisclosure");
        Objects.requireNonNull(modelExecution, "modelExecution");
        Objects.requireNonNull(automaticUploads, "automaticUploads");
        Objects.requireNonNull(automaticDownloads, "automaticDownloads");
        Objects.requireNonNull(automaticSudo, "automaticSudo");
        Objects.requireNonNull(testServer, "testServer");
        Objects.requireNonNull(sourceExecutionContract, "sourceExecutionContract");
        Objects.requireNonNull(fallback, "fallback");
        Objects.requireNonNull(thresholds, "thresholds");
        requireNamesOfPlatform(commands, os);
        requireNamesOfPlatform(deniedCommands, os);
    }

    private static void requireNamesOfPlatform(CommandNames names, TargetOs os) {
        for (PolicyName name : names.names()) {
            boolean windowsName = name instanceof WindowsPolicyName;
            if (windowsName != (os == TargetOs.WINDOWS)) {
                throw new IllegalArgumentException("A rule for a " + os.wire() + " target lists " + os.wire() + " command names only: " + name.text());
            }
        }
    }

    /**
     * True when a denied name is among the names the grammar found in the command, or is one of the words of the command text. The second part is a
     * conservative scan that catches what a grammar does not know (a name inside an argument, a path, a quoted string): {@code sudo /bin/rm /tmp/x} is denied by a
     * rule that denies {@code rm} (command-policy.mjs:98, case RC-A-423).
     */
    public boolean denies(CommandLineAnalysis analysis, CommandText command) {
        return deniesWords(analysis, command.value());
    }

    /**
     * The same judgement for text that is not a command line but is run with one, such as the source and the arguments of a submitted program
     * (command-automation.mjs:25 {@code sourceDenied}).
     */
    public boolean deniesWords(CommandLineAnalysis analysis, String text) {
        if (deniedCommands.isEmpty()) {
            return false;
        }
        Set<String> words = new HashSet<>(List.of(NOT_A_NAME_CHARACTER.split(text)));
        words.addAll(analysis.names());
        return deniedCommands.keys().stream().anyMatch(words::contains);
    }

    /**
     * True when every name of the command is one the owner approved: the grammar is sure of all names, and each is listed (for {@code sudo}: the
     * {@code automaticSudo} switch is on). The command line may still need the full evaluation; this only answers the name match (command-automation.mjs:141).
     */
    public boolean approves(CommandLineAnalysis analysis) {
        if (!analysis.isComplete()) {
            return false;
        }
        for (String name : analysis.names()) {
            boolean approved = os == TargetOs.LINUX && SUDO.equals(name) ? automaticSudo.isOn() : commands.containsKey(name);
            if (!approved) {
                return false;
            }
        }
        return true;
    }

    /**
     * The names that count as pre-approved for the evaluator and for the statement of explicit approval: on a POSIX target the listed names without
     * {@code sudo}, plus {@code sudo} only when its switch is on; on Windows all listed names (command-automation.mjs:35).
     */
    public List<PolicyName> preapprovedNames() {
        List<PolicyName> approved = new ArrayList<>();
        for (PolicyName name : commands.names()) {
            if (os == TargetOs.LINUX && SUDO.equals(name.key())) {
                continue;
            }
            approved.add(name);
        }
        if (os == TargetOs.LINUX && automaticSudo.isOn()) {
            approved.add(new LinuxPolicyName(SUDO));
        }
        return List.copyOf(approved);
    }

    /** True when this rule is the one for the given target, revision and profile; a rule of another revision does not apply (command-automation.mjs:28). */
    public boolean appliesTo(TargetId target, TargetRevision revision, ProfileAlias writeProfile) {
        return targetId.equals(target) && targetRevision.equals(revision) && profile.equals(writeProfile);
    }
}
