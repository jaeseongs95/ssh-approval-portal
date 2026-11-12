package io.github.jaeseongs95.portal.ssh.platform;

import io.github.jaeseongs95.portal.app.remote.AgentCliPlan;
import io.github.jaeseongs95.portal.app.remote.ElevationPlan;
import io.github.jaeseongs95.portal.app.remote.ExecReply;
import io.github.jaeseongs95.portal.app.remote.FixedRemoteCommand;
import io.github.jaeseongs95.portal.app.remote.PathPolicyBinding;
import io.github.jaeseongs95.portal.app.remote.PermissionSupport;
import io.github.jaeseongs95.portal.app.remote.PreparedCommand;
import io.github.jaeseongs95.portal.app.remote.SourceArguments;
import io.github.jaeseongs95.portal.app.remote.UnsupportedReason;
import io.github.jaeseongs95.portal.app.remote.WorkingDirectory;
import io.github.jaeseongs95.portal.app.target.TargetPlatform;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliIntent;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;
import io.github.jaeseongs95.portal.domain.classify.CommandClass;
import io.github.jaeseongs95.portal.domain.classify.CommandClassification;
import io.github.jaeseongs95.portal.domain.command.CommandLineGrammar;
import io.github.jaeseongs95.portal.domain.command.PolicyName;
import io.github.jaeseongs95.portal.domain.command.TargetRule;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.path.PathSyntax;
import io.github.jaeseongs95.portal.domain.target.Target;
import io.github.jaeseongs95.portal.domain.target.TargetCapabilities;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.target.WindowsDirectory;
import io.github.jaeseongs95.portal.domain.target.WindowsPythonExecutable;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.SourceText;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * What differs about a Windows target running Windows PowerShell 5.1 over the Win32-OpenSSH server: the path grammar with its allowed-root rule, the capabilities, the
 * wrapping of a command for PowerShell (an encoded command that reports errors, silences progress records and stays under the 8000-character limit of the shell), the
 * Python receiver, the lack of {@code chmod} in its SFTP server, the check of an administrator connection, and the fixed commands of an agent CLI installation (stage 3
 * design 2.3). The class has no operating-system test in it: it is the {@link TargetPlatform} the registry finds for {@code TargetOs.WINDOWS}.
 *
 * <p>Everything this class makes is run on the target, not here: PowerShell, {@code python.exe} and {@code tar.exe} are programs of the target. Java cannot replace
 * them because the target is another machine that has no JVM and the work is to run what the owner approved there; they are a product feature and not a helper of this
 * server (docs/external-programs). Nothing here starts a process on this server. The fixed commands hold no text of a caller.
 *
 * <p>{@link #execReply()} is {@link ExecReply#AWAITED} for now, the same as for POSIX targets. Whether Win32-OpenSSH answers the {@code exec} request is shown by the
 * Windows tests against a real server (S3-RW-01); if it does not, this method answers {@link ExecReply#NOT_AWAITED} and nothing else changes (decision D3-06).
 */
@Component
public final class WindowsTargetPlatform implements TargetPlatform {

    /** The two cmdlets, qualified by their module, that are read only without arguments (2.x target-platform.mjs:20-28). */
    private static final Pattern READ_ONLY = Pattern.compile("(?:Microsoft\\.PowerShell\\.Utility\\\\Get-Date|Microsoft\\.PowerShell\\.Management\\\\Get-Location)",
        Pattern.CASE_INSENSITIVE);
    private static final Pattern NOT_A_NAME_CHARACTER = Pattern.compile("[^a-z0-9_.+-]+");
    private static final Pattern PATH_SEPARATOR = Pattern.compile("[\\\\/]");
    /** Ends with 0 when the connection's token is the administrator's, with 1 when it is not. */
    private static final String ADMINISTRATOR_PROBE = "$p=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent();"
        + "exit ([int](-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)))";

    private final WindowsCommandLineGrammar grammar;
    private final WindowsCommandWrapper wrapper;
    private final PythonSourceReceiver receiver;

    /**
     * @param grammar reads the command names of a PowerShell line
     * @param wrapper wraps a command for PowerShell
     * @param receiver makes the command of a Python source run
     */
    public WindowsTargetPlatform(WindowsCommandLineGrammar grammar, WindowsCommandWrapper wrapper, PythonSourceReceiver receiver) {
        this.grammar = Objects.requireNonNull(grammar, "grammar");
        this.wrapper = Objects.requireNonNull(wrapper, "wrapper");
        this.receiver = Objects.requireNonNull(receiver, "receiver");
    }

    @Override
    public TargetOs os() {
        return TargetOs.WINDOWS;
    }

    @Override
    public PathSyntax pathSyntax() {
        return PathSyntax.WINDOWS;
    }

    @Override
    public TargetCapabilities capabilities(Target target) {
        return target.capabilities();
    }

    /** Only the two module-qualified read-only cmdlets are {@code read-only}; everything else is {@code safe}, and the POSIX classifier is not asked (RC-B-626). */
    @Override
    public CommandClassification classify(CommandText command) {
        boolean readOnly = !command.isMultiline() && READ_ONLY.matcher(command.value().strip()).matches();
        return CommandClassification.of(readOnly ? CommandClass.READ_ONLY : CommandClass.SAFE);
    }

    @Override
    public CommandLineGrammar commandLineGrammar() {
        return grammar;
    }

    /** A deny hint, not a PowerShell parser (2.x {@code deniedForTarget}): a denied name is the last path segment of the name, compared in lower case with the words of the line. */
    @Override
    public boolean deniesName(TargetRule rule, CommandText command) {
        Set<String> words = new HashSet<>(List.of(NOT_A_NAME_CHARACTER.split(command.value().toLowerCase(Locale.ROOT))));
        for (PolicyName denied : rule.deniedCommands().names()) {
            String[] segments = PATH_SEPARATOR.split(denied.key().toLowerCase(Locale.ROOT));
            if (words.contains(segments[segments.length - 1])) {
                return true;
            }
        }
        return false;
    }

    @Override
    public PreparedCommand prepareCommand(CommandText command, WorkingDirectory workdir) {
        return wrapper.prepare(command, workdir);
    }

    /**
     * A source run on a Windows target needs the Python the administrator configured for the target, which this call is not given: the port has no parameter for it.
     * Until it has one, the platform refuses the call; a caller that holds the target's interpreter uses {@link #prepareSource(SourceText, SourceArguments,
     * WindowsDirectory, WindowsPythonExecutable, boolean)}. The capabilities of the target say {@code pythonSource} false when no interpreter is configured, so a caller
     * that reads them never gets here.
     */
    @Override
    public PreparedCommand prepareSource(SourceText source, SourceArguments args, WorkingDirectory workdir) {
        throw new RequestRefusedException(RequestErrorCode.TARGET_CAPABILITY_UNSUPPORTED);
    }

    /** The command that runs a Python source with the interpreter of the target; {@code elevate} asks for the administrator check inside the receiver. */
    public PreparedCommand prepareSource(SourceText source, SourceArguments args, WindowsDirectory cwd, WindowsPythonExecutable interpreter, boolean elevate) {
        return receiver.prepareWindows(source, args, cwd, interpreter, elevate);
    }

    @Override
    public PathPolicyBinding pathPolicy(Target target) {
        return new PathPolicyBinding.RootPolicy(PathSyntax.WINDOWS);
    }

    /** The SFTP server of Win32-OpenSSH has no {@code chmod} (its wiki: "SFTP doesn't support chmod"). */
    @Override
    public PermissionSupport permissionSupport() {
        return new PermissionSupport.Unsupported(UnsupportedReason.WINDOWS_SFTP_CHMOD);
    }

    @Override
    public ElevationPlan elevationPlan() {
        return new ElevationPlan.WindowsAdministratorCheck(new FixedRemoteCommand("admin-probe", wrapper.wrap(ADMINISTRATOR_PROBE).commandLine()));
    }

    /**
     * The fixed PowerShell command that unpacks a release under the profile folder of the account: {@code tar.exe} (Windows 10 version 1803 and later; the target's own) on
     * the package file the installer uploaded. It is the only command of the installation; the installer does the rest over SFTP. Unchecked against a real Windows server
     * (S3-RW).
     */
    @Override
    public AgentCliPlan agentCliPlan(AgentCliIntent intent, AgentRelease release) {
        AgentCliLayout layout = new AgentCliLayout(intent.provider(), release);
        // The one command: unpack the package where the installer put it, and end with the exit code of tar.exe.
        List<FixedRemoteCommand> commands = new ArrayList<>();
        commands.add(step(AgentCliStep.UNPACK, "Set-Location -LiteralPath " + profilePath(layout.partialDirectory()) + ";tar.exe -xzf package.tgz;exit $LASTEXITCODE"));
        return new AgentCliPlan(intent.provider(), release, commands);
    }

    /** Whether the server of a Windows target answers the {@code exec} request is shown by the real-server tests; see the class comment. */
    @Override
    public ExecReply execReply() {
        return ExecReply.AWAITED;
    }

    private FixedRemoteCommand step(AgentCliStep step, String script) {
        return new FixedRemoteCommand(step.label(), wrapper.wrap(script).commandLine());
    }

    /** A path under the profile folder, as a PowerShell expression; the relative part is made of validated release parts and has no character PowerShell reads. */
    private static String profilePath(String relative) {
        return "(Join-Path $env:USERPROFILE '" + relative.replace('/', '\\') + "')";
    }
}
