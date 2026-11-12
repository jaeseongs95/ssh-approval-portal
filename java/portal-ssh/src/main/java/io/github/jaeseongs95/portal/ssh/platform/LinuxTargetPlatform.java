package io.github.jaeseongs95.portal.ssh.platform;

import io.github.jaeseongs95.portal.app.remote.AgentCliPlan;
import io.github.jaeseongs95.portal.app.remote.CommandKind;
import io.github.jaeseongs95.portal.app.remote.ElevationPlan;
import io.github.jaeseongs95.portal.app.remote.ExecReply;
import io.github.jaeseongs95.portal.app.remote.FixedRemoteCommand;
import io.github.jaeseongs95.portal.app.remote.PathPolicyBinding;
import io.github.jaeseongs95.portal.app.remote.PermissionSupport;
import io.github.jaeseongs95.portal.app.remote.PreparedCommand;
import io.github.jaeseongs95.portal.app.remote.SourceArguments;
import io.github.jaeseongs95.portal.app.remote.StdinBytes;
import io.github.jaeseongs95.portal.app.remote.WorkingDirectory;
import io.github.jaeseongs95.portal.app.target.TargetPlatform;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliIntent;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;
import io.github.jaeseongs95.portal.domain.classify.CommandClassification;
import io.github.jaeseongs95.portal.domain.classify.CommandClassifier;
import io.github.jaeseongs95.portal.domain.command.CommandLineGrammar;
import io.github.jaeseongs95.portal.domain.command.TargetRule;
import io.github.jaeseongs95.portal.domain.path.PathSyntax;
import io.github.jaeseongs95.portal.domain.target.Target;
import io.github.jaeseongs95.portal.domain.target.TargetCapabilities;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.SourceText;
import io.github.jaeseongs95.portal.ssh.sftp.ShellWord;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import org.springframework.stereotype.Component;

/**
 * What differs about a POSIX target (Linux): the path grammar, the capabilities, the way a command and a script are handed to its shell, what its SFTP server can do and
 * how it is asked for elevated rights (stage 3 design 2.3). The class has no operating-system test in it: it is the {@link TargetPlatform} the registry finds for
 * {@code TargetOs.LINUX}, and the shared code never asks which system it talks to.
 *
 * <p>The commands this class makes are run on the target, not here: a command line, the Python receiver and the fixed commands of an agent CLI installation are programs of
 * the target (the shell, {@code python3}, {@code tar}, {@code ln}, {@code sudo}). Java cannot replace them because the target is another machine that has no JVM and the
 * work is to run what the owner approved there; they are a product feature and not a helper of this server (docs/external-programs). Nothing in this class starts a process
 * on this server. The fixed commands hold no text of a caller: the parts they are made of are validated values of the release.
 */
@Component
public final class LinuxTargetPlatform implements TargetPlatform {

    private static final ElevationPlan ELEVATION = new ElevationPlan.SudoNonInteractive(new FixedRemoteCommand("sudo-probe", "sudo -n true"));

    private final CommandClassifier classifier;
    private final PosixCommandLineGrammar grammar;
    private final PythonSourceReceiver receiver;

    /**
     * @param classifier the vendor classification of a command line
     * @param grammar reads the program names of a command line
     * @param receiver makes the command of a Python source run
     */
    public LinuxTargetPlatform(CommandClassifier classifier, PosixCommandLineGrammar grammar, PythonSourceReceiver receiver) {
        this.classifier = Objects.requireNonNull(classifier, "classifier");
        this.grammar = Objects.requireNonNull(grammar, "grammar");
        this.receiver = Objects.requireNonNull(receiver, "receiver");
    }

    @Override
    public TargetOs os() {
        return TargetOs.LINUX;
    }

    @Override
    public PathSyntax pathSyntax() {
        return PathSyntax.POSIX;
    }

    @Override
    public TargetCapabilities capabilities(Target target) {
        return target.capabilities();
    }

    @Override
    public CommandClassification classify(CommandText command) {
        return classifier.classify(command);
    }

    @Override
    public CommandLineGrammar commandLineGrammar() {
        return grammar;
    }

    @Override
    public boolean deniesName(TargetRule rule, CommandText command) {
        return rule.denies(grammar.analyze(command), command);
    }

    /** The line goes to the shell as it is, behind a change into the working directory when there is one. */
    @Override
    public PreparedCommand prepareCommand(CommandText command, WorkingDirectory workdir) {
        String line = switch (workdir) {
            case WorkingDirectory.Default none -> command.value();
            case WorkingDirectory.At at -> "cd " + new ShellWord(at.directory().value()).quoted() + " && " + command.value();
        };
        return new PreparedCommand(line, StdinBytes.none(), CommandKind.COMMAND);
    }

    /** A script without a working directory starts in {@code /}: the receiver needs an absolute one. */
    @Override
    public PreparedCommand prepareSource(SourceText source, SourceArguments args, WorkingDirectory workdir) {
        String cwd = switch (workdir) {
            case WorkingDirectory.Default none -> "/";
            case WorkingDirectory.At at -> at.directory().value();
        };
        return receiver.prepareLinux(source, args, cwd, false);
    }

    @Override
    public PathPolicyBinding pathPolicy(Target target) {
        return new PathPolicyBinding.NoRootPolicy();
    }

    @Override
    public PermissionSupport permissionSupport() {
        return new PermissionSupport.Supported();
    }

    @Override
    public ElevationPlan elevationPlan() {
        return ELEVATION;
    }

    /**
     * The fixed commands that install a release under the home directory of the account. The package file is unpacked with {@code tar} and its version is read from its
     * metadata file ({@code package.json}); nothing that was installed is run, so a package that lies about itself cannot execute anything on the target at this point.
     * Whether a target needs {@code npm} or {@code node} for the tool to work after that is not known (pilot P3-6).
     */
    @Override
    public AgentCliPlan agentCliPlan(AgentCliIntent intent, AgentRelease release) {
        AgentCliLayout layout = new AgentCliLayout(intent.provider(), release);
        String partial = home(layout.partialDirectory());
        String finalDirectory = home(layout.finalDirectory());
        String current = home(layout.currentLink());
        String next = home(layout.providerRoot() + "/current.next");
        String previous = home(layout.providerRoot() + "/current.previous");
        List<FixedRemoteCommand> commands = new ArrayList<>();
        commands.add(step(AgentCliStep.TARBALL_PATH, "printf '%s' " + home(layout.partialDirectory() + "/package.tgz")));
        commands.add(step(AgentCliStep.FINAL_PATH, "printf '%s' " + finalDirectory));
        // The two reads of current differ by a no-op word, so that every step of a plan is a command of its own and a step is never mistaken for another by its text.
        commands.add(step(AgentCliStep.CURRENT_BEFORE, ": before; readlink " + current + " 2>/dev/null; exit 0"));
        commands.add(step(AgentCliStep.PREPARE, "mkdir -p " + partial));
        commands.add(step(AgentCliStep.UNPACK, "cd " + partial + " && tar -xzf package.tgz && rm -f package.tgz && cd .. && rm -rf " + finalDirectory + " && mv " + partial
            + " " + finalDirectory));
        commands.add(step(AgentCliStep.VERSION, "sed -n 's/^ *\"version\": *\"\\([^\"]*\\)\".*/\\1/p' " + home(layout.finalDirectory() + "/package/package.json") + " | head -n 1"));
        commands.add(step(AgentCliStep.KEEP_PREVIOUS, "rm -f " + previous + "; if [ -L " + current + " ]; then cp -P " + current + " " + previous + "; fi"));
        commands.add(step(AgentCliStep.SWITCH, "ln -sfn " + finalDirectory + " " + next + " && mv -Tf " + next + " " + current));
        commands.add(step(AgentCliStep.CURRENT_AFTER, ": after; readlink " + current + " 2>/dev/null; exit 0"));
        commands.add(step(AgentCliStep.ROLLBACK, "mv -Tf " + previous + " " + current));
        commands.add(step(AgentCliStep.ROLLBACK_NONE, "rm -f " + current));
        commands.add(step(AgentCliStep.DROP_PREVIOUS, "rm -f " + previous));
        commands.add(step(AgentCliStep.CLEANUP, "rm -rf " + partial));
        return new AgentCliPlan(intent.provider(), release, commands);
    }

    /** The reply to {@code exec} is awaited: OpenSSH answers it. */
    @Override
    public ExecReply execReply() {
        return ExecReply.AWAITED;
    }

    /** A path under the home directory, in double quotes so that the shell expands only {@code $HOME}; the relative part has no character the shell reads. */
    private static String home(String relative) {
        return "\"$HOME/" + relative + "\"";
    }

    private static FixedRemoteCommand step(AgentCliStep step, String commandLine) {
        return new FixedRemoteCommand(step.label(), commandLine);
    }
}
