package io.github.jaeseongs95.portal.ssh.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.app.remote.AgentCliPlan;
import io.github.jaeseongs95.portal.app.remote.FixedRemoteCommand;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliIntent;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProviderId;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The fixed commands of an agent CLI installation (S3-AG-10, stage 3 design 6.2): the remote commands of a plan are the unpacking of the package and nothing else; the
 * rest of the installation is SFTP and Java. The command is made of validated release parts only, in each platform's shell.
 */
class AgentCliPlansTest {

    private final PlatformFixtures fixtures = new PlatformFixtures();
    private final RemoteScripts scripts = new RemoteScripts();
    private final PythonSourceReceiver receiver = new PythonSourceReceiver(scripts, new Sha256Digester());
    private final LinuxTargetPlatform linux = new LinuxTargetPlatform(command -> {
        throw new IllegalStateException("the plan does not classify");
    }, new PosixCommandLineGrammar(), receiver);
    private final WindowsTargetPlatform windows = new WindowsTargetPlatform(new WindowsCommandLineGrammar(), new WindowsCommandWrapper(scripts), receiver);

    private AgentRelease release(AgentCliProviderId tool) {
        return fixtures.release(tool, fixtures.integrityOf(new byte[64]));
    }

    private AgentCliPlan linuxPlan(AgentCliProviderId tool) {
        AgentRelease release = release(tool);
        return linux.agentCliPlan(fixtures.intent(release), release);
    }

    private AgentCliPlan windowsPlan(AgentCliProviderId tool) {
        AgentRelease release = release(tool);
        return windows.agentCliPlan(fixtures.intent(release), release);
    }

    @Test
    @DisplayName("S3-AG-10 the remote commands of a plan are the unpacking of the package and nothing else, on both platforms")
    void onlyTheUnpackIsRemote() {
        for (AgentCliPlan plan : List.of(linuxPlan(AgentCliProviderId.CODEX), windowsPlan(AgentCliProviderId.CLAUDE))) {
            assertThat(plan.commands().stream().map(FixedRemoteCommand::label).toList()).containsExactly("unpack");
            assertThat(AgentCliStep.values()).containsExactly(AgentCliStep.UNPACK);
            assertThat(AgentCliStep.UNPACK.in(plan).label()).isEqualTo(AgentCliStep.UNPACK.label());
        }
    }

    @Test
    @DisplayName("S3-AG-10 the POSIX unpack command is tar on the package file in the partial directory of the release, and nothing else: no readlink, mkdir, sed, grep, cp, rm, mv or ln")
    void linuxCommand() {
        AgentRelease release = release(AgentCliProviderId.CODEX);
        AgentCliPlan plan = linux.agentCliPlan(fixtures.intent(release), release);
        String directory = PlatformFixtures.VERSION + "-" + release.releaseDigest().hex().substring(0, 16);

        assertThat(AgentCliStep.UNPACK.in(plan).commandLine())
            .isEqualTo("cd \"$HOME/.ssh-approval-portal/agent-cli/codex/versions/" + directory + ".partial\" && tar -xzf package.tgz");
        assertThat(plan.commands()).allSatisfy(command -> assertThat(command.commandLine()).doesNotContain("readlink", "mkdir", "sed ", "grep", "cp ", "rm ", "mv ", "ln ", "npm ",
            "fixture-request-key"));
    }

    @Test
    @DisplayName("S3-AG-10 the commands of the two tools differ only in the tool's directory; no step runs an installed program")
    void toolsAndNoInstalledProgram() {
        AgentCliPlan codex = linuxPlan(AgentCliProviderId.CODEX);
        AgentCliPlan claude = linuxPlan(AgentCliProviderId.CLAUDE);

        assertThat(AgentCliStep.UNPACK.in(codex).commandLine()).contains("/agent-cli/codex/");
        assertThat(AgentCliStep.UNPACK.in(claude).commandLine()).contains("/agent-cli/claude/");
        assertThat(codex.commands()).allSatisfy(command -> assertThat(command.commandLine()).doesNotContain("/package/bin").doesNotContain("--version"));
    }

    @Test
    @DisplayName("S3-AG-10 RC-B-625 the Windows unpack command is one PowerShell line under the shell's 8000-character limit")
    void windowsCommand() {
        AgentCliPlan plan = windowsPlan(AgentCliProviderId.CODEX);

        assertThat(plan.commands()).hasSize(1);
        assertThat(plan.commands().get(0).commandLine()).startsWith("powershell.exe ").hasSizeLessThanOrEqualTo(8000).doesNotContain("fixture-request-key");
    }

    @Test
    @DisplayName("S3-AG-10 the intent decides the tool only: a plan for another provider than its release is refused by the plan itself")
    void planChecksProvider() {
        AgentRelease codex = release(AgentCliProviderId.CODEX);
        AgentCliIntent claudeIntent = fixtures.intent(release(AgentCliProviderId.CLAUDE));

        assertThatThrownBy(() -> linux.agentCliPlan(claudeIntent, codex)).isInstanceOf(IllegalArgumentException.class);
    }
}
