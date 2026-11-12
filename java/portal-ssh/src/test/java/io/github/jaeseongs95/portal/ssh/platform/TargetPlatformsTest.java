package io.github.jaeseongs95.portal.ssh.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.app.remote.CommandKind;
import io.github.jaeseongs95.portal.app.remote.ElevationPlan;
import io.github.jaeseongs95.portal.app.remote.ExecReply;
import io.github.jaeseongs95.portal.app.remote.PathPolicyBinding;
import io.github.jaeseongs95.portal.app.remote.PermissionSupport;
import io.github.jaeseongs95.portal.app.remote.PreparedCommand;
import io.github.jaeseongs95.portal.app.remote.SourceArguments;
import io.github.jaeseongs95.portal.app.remote.UnsupportedReason;
import io.github.jaeseongs95.portal.app.remote.WorkingDirectory;
import io.github.jaeseongs95.portal.app.target.TargetPlatformRegistry;
import io.github.jaeseongs95.portal.domain.classify.CommandClass;
import io.github.jaeseongs95.portal.domain.classify.CommandClassification;
import io.github.jaeseongs95.portal.domain.classify.CommandClassifier;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.path.PathSyntax;
import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import io.github.jaeseongs95.portal.domain.path.WindowsRemotePath;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.SourceText;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** The two target platforms (S3-TP-01 to S3-TP-03, S3-TP-08, S3-EL-04, S3-SF-11): what they answer, with no operating-system test in the shared code. */
class TargetPlatformsTest {

    private final PlatformFixtures fixtures = new PlatformFixtures();
    private final AtomicInteger classifierCalls = new AtomicInteger();
    private final CommandClassifier classifier = command -> {
        classifierCalls.incrementAndGet();
        return CommandClassification.of(CommandClass.DESTRUCTIVE);
    };
    private final RemoteScripts scripts = new RemoteScripts();
    private final PythonSourceReceiver receiver = new PythonSourceReceiver(scripts, new Sha256Digester());
    private final LinuxTargetPlatform linux = new LinuxTargetPlatform(classifier, new PosixCommandLineGrammar(), receiver);
    private final WindowsTargetPlatform windows = new WindowsTargetPlatform(new WindowsCommandLineGrammar(), new WindowsCommandWrapper(scripts), receiver);

    @Test
    @DisplayName("S3-TP-01 the registry takes one platform per system, and a missing or a doubled one stops the start")
    void registry() {
        TargetPlatformRegistry registry = new TargetPlatformRegistry(List.of(linux, windows));

        assertThat(registry.platformOf(TargetOs.LINUX)).isSameAs(linux);
        assertThat(registry.platformOf(TargetOs.WINDOWS)).isSameAs(windows);
        assertThatThrownBy(() -> new TargetPlatformRegistry(List.of(linux))).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new TargetPlatformRegistry(List.of(linux, windows, linux))).isInstanceOf(IllegalStateException.class);
    }

    @Test
    @DisplayName("S3-TP-02 each platform answers its own system and path syntax")
    void pathSyntax() {
        assertThat(linux.os()).isEqualTo(TargetOs.LINUX);
        assertThat(windows.os()).isEqualTo(TargetOs.WINDOWS);
        assertThat(linux.pathSyntax()).isEqualTo(PathSyntax.POSIX);
        assertThat(windows.pathSyntax()).isEqualTo(PathSyntax.WINDOWS);
        assertThat(linux.pathSyntax().path("/srv/a.bin")).isInstanceOf(PosixRemotePath.class);
        assertThat(windows.pathSyntax().path("C:\\srv\\a.bin")).isInstanceOf(WindowsRemotePath.class);
        assertThatThrownBy(() -> windows.pathSyntax().path("/srv/a.bin")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S3-TP-03 RC-B-568 a Windows target runs sources only with a configured Python; a Linux target always does")
    void capabilities() {
        assertThat(windows.capabilities(fixtures.target(TargetOs.WINDOWS, false)).pythonSource()).isFalse();
        assertThat(windows.capabilities(fixtures.target(TargetOs.WINDOWS, true)).pythonSource()).isTrue();
        assertThat(linux.capabilities(fixtures.target(TargetOs.LINUX, false)).pythonSource()).isTrue();
    }

    @Test
    @DisplayName("S3-TP-08 RC-B-626 Windows: only the two module-qualified cmdlets without arguments are read-only, everything else safe, and the POSIX classifier is not asked")
    void windowsClassification() {
        for (String readOnly : List.of("Microsoft.PowerShell.Utility\\Get-Date", "Microsoft.PowerShell.Management\\Get-Location", "  microsoft.powershell.utility\\get-date  ")) {
            assertThat(windows.classify(new CommandText(readOnly)).commandClass()).as(readOnly).isEqualTo(CommandClass.READ_ONLY);
        }
        for (String safe : List.of("Get-Date", "Get-Location", "hostname", "ls", "Microsoft.PowerShell.Utility\\Get-Date -Format o", "Microsoft.PowerShell.Utility\\Get-Date; Remove-Item x",
            "Microsoft.PowerShell.Management\\Get-Location | Set-Content x", "& { Get-Date }", "Microsoft.PowerShell.Utility\\Get-Date\nid")) {
            assertThat(windows.classify(new CommandText(safe)).commandClass()).as(safe).isEqualTo(CommandClass.SAFE);
        }
        assertThat(classifierCalls.get()).isZero();
    }

    @Test
    @DisplayName("S3-TP-08 Linux hands the line to the classifier it was given")
    void linuxClassificationDelegates() {
        CommandClassification result = linux.classify(new CommandText("rm -rf /tmp/x"));

        assertThat(result.commandClass()).isEqualTo(CommandClass.DESTRUCTIVE);
        assertThat(classifierCalls.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("S3-TP-07 each platform names the grammar of its own system")
    void grammars() {
        assertThat(linux.commandLineGrammar().platform()).isEqualTo(TargetOs.LINUX);
        assertThat(windows.commandLineGrammar().platform()).isEqualTo(TargetOs.WINDOWS);
    }

    @Test
    @DisplayName("S3-TP-04 a Linux command goes to the shell as it is, behind a change into the working directory when there is one; the directory is one quoted word")
    void linuxCommand() {
        PreparedCommand plain = linux.prepareCommand(new CommandText("ls -la"), new WorkingDirectory.Default());
        PreparedCommand inDirectory = linux.prepareCommand(new CommandText("ls -la"), new WorkingDirectory.At(new PosixRemotePath("/srv/it's here")));

        assertThat(plain.commandLine()).isEqualTo("ls -la");
        assertThat(plain.kind()).isEqualTo(CommandKind.COMMAND);
        assertThat(plain.stdin().length()).isZero();
        assertThat(inDirectory.commandLine()).isEqualTo("cd '/srv/it'\\''s here' && ls -la");
    }

    @Test
    @DisplayName("S3-TP-04 a Windows command is wrapped for PowerShell: the command line is one encoded line and the owner's text travels as standard input")
    void windowsCommand() {
        PreparedCommand prepared = windows.prepareCommand(new CommandText("whoami.exe"), new WorkingDirectory.Default());

        assertThat(prepared.commandLine()).startsWith("powershell.exe -NoLogo -NoProfile -NonInteractive").contains("-EncodedCommand").hasSizeLessThanOrEqualTo(8000);
        assertThat(prepared.commandLine()).doesNotContain("whoami");
        assertThat(new String(prepared.stdin().bytes(), java.nio.charset.StandardCharsets.UTF_8)).isEqualTo("whoami.exe");
    }

    @Test
    @DisplayName("S3-TP-06 a Linux source runs in / when no directory is given and in the given one otherwise; a Windows source needs the target's interpreter and is refused without it")
    void sources() {
        SourceText source = new SourceText("print('ok')\n");

        PreparedCommand inRoot = linux.prepareSource(source, SourceArguments.none(), new WorkingDirectory.Default());
        PreparedCommand inDirectory = linux.prepareSource(source, SourceArguments.none(), new WorkingDirectory.At(new PosixRemotePath("/srv/work")));

        assertThat(inRoot.kind()).isEqualTo(CommandKind.SOURCE);
        assertThat(inRoot.commandLine()).contains("'/usr/bin/python3'");
        assertThat(inRoot.commandLine()).endsWith(" '/'").doesNotContain("'/srv/work'");
        assertThat(inDirectory.commandLine()).contains("'/srv/work'");
        assertThat(new String(inRoot.stdin().bytes(), java.nio.charset.StandardCharsets.UTF_8)).isEqualTo("print('ok')\n");
        assertThatThrownBy(() -> windows.prepareSource(source, SourceArguments.none(), new WorkingDirectory.Default()))
            .isInstanceOfSatisfying(RequestRefusedException.class, refused -> assertThat(refused.code()).isEqualTo(RequestErrorCode.TARGET_CAPABILITY_UNSUPPORTED));
    }

    @Test
    @DisplayName("S3-SF-11 S3-EL-04 permissions, path policy and elevation are values of the platform: Linux sets modes and uses sudo -n, Windows cannot chmod, has a root rule and checks the administrator")
    void filesAndElevation() {
        assertThat(linux.permissionSupport()).isEqualTo(new PermissionSupport.Supported());
        assertThat(windows.permissionSupport()).isEqualTo(new PermissionSupport.Unsupported(UnsupportedReason.WINDOWS_SFTP_CHMOD));
        assertThat(linux.pathPolicy(fixtures.target(TargetOs.LINUX, false))).isEqualTo(new PathPolicyBinding.NoRootPolicy());
        assertThat(windows.pathPolicy(fixtures.target(TargetOs.WINDOWS, false))).isEqualTo(new PathPolicyBinding.RootPolicy(PathSyntax.WINDOWS));
        assertThat(linux.elevationPlan()).isInstanceOf(ElevationPlan.SudoNonInteractive.class);
        assertThat(((ElevationPlan.SudoNonInteractive) linux.elevationPlan()).probe().commandLine()).isEqualTo("sudo -n true");
        assertThat(windows.elevationPlan()).isInstanceOf(ElevationPlan.WindowsAdministratorCheck.class);
        String probe = ((ElevationPlan.WindowsAdministratorCheck) windows.elevationPlan()).probe().commandLine();
        assertThat(probe).startsWith("powershell.exe ").hasSizeLessThanOrEqualTo(8000);
    }

    @Test
    @DisplayName("D3-06 both platforms await the reply to the exec request for now; the Windows answer may change with the real-server tests (S3-RW-01)")
    void execReply() {
        assertThat(linux.execReply()).isEqualTo(ExecReply.AWAITED);
        assertThat(windows.execReply()).isEqualTo(ExecReply.AWAITED);
    }
}
