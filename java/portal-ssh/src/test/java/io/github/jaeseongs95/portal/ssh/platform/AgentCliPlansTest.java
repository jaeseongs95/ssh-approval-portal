package io.github.jaeseongs95.portal.ssh.platform;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.app.remote.AgentCliPlan;
import io.github.jaeseongs95.portal.app.remote.FixedRemoteCommand;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliIntent;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProviderId;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Pattern;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** The fixed commands of an agent CLI installation (S3-AG-10, stage 3 design 6.2): one for each step, made of validated release parts only, in each platform's shell. */
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
    @DisplayName("S3-AG-10 each platform's plan has exactly one command for every step, and the labels are the steps' labels")
    void everyStepOnce() {
        for (AgentCliPlan plan : List.of(linuxPlan(AgentCliProviderId.CODEX), windowsPlan(AgentCliProviderId.CLAUDE))) {
            assertThat(plan.commands().stream().map(FixedRemoteCommand::label).toList()).containsExactlyInAnyOrder(
                Arrays.stream(AgentCliStep.values()).map(AgentCliStep::label).toArray(String[]::new));
            for (AgentCliStep step : AgentCliStep.values()) {
                assertThat(step.in(plan).label()).isEqualTo(step.label());
            }
        }
    }

    @Test
    @DisplayName("S3-AG-10 D-0035 no two steps of a plan share a command text, so a step can never be taken for another by its text")
    void commandsAreDistinct() {
        for (AgentCliPlan plan : List.of(linuxPlan(AgentCliProviderId.CODEX), windowsPlan(AgentCliProviderId.CODEX))) {
            assertThat(plan.commands().stream().map(FixedRemoteCommand::commandLine).distinct().count()).isEqualTo(plan.commands().size());
        }
    }

    @Test
    @DisplayName("S3-AG-10 a POSIX plan works under the home directory of the tool and the version, with the first 16 hex characters of the release digest in the directory name")
    void linuxCommands() {
        AgentRelease release = release(AgentCliProviderId.CODEX);
        AgentCliPlan plan = linux.agentCliPlan(fixtures.intent(release), release);
        String directory = PlatformFixtures.VERSION + "-" + release.releaseDigest().hex().substring(0, 16);

        assertThat(AgentCliStep.FINAL_PATH.in(plan).commandLine()).isEqualTo("printf '%s' \"$HOME/.ssh-approval-portal/agent-cli/codex/versions/" + directory + "\"");
        assertThat(AgentCliStep.TARBALL_PATH.in(plan).commandLine()).contains(directory + ".partial/package.tgz");
        assertThat(AgentCliStep.UNPACK.in(plan).commandLine()).startsWith("cd \"$HOME/").contains("tar -xzf package.tgz");
        assertThat(AgentCliStep.SWITCH.in(plan).commandLine()).contains("ln -sfn").contains("mv -Tf");
        assertThat(AgentCliStep.CURRENT_BEFORE.in(plan).commandLine()).contains("readlink ").startsWith(": before;");
        assertThat(AgentCliStep.VERSION.in(plan).commandLine()).contains("package/package.json");
        assertThat(plan.commands()).allSatisfy(command -> assertThat(command.commandLine()).as(command.label()).doesNotContain("fixture-request-key").doesNotContain("npm "));
    }

    @Test
    @DisplayName("S3-AG-10 the commands of the two tools differ only in the tool's directory; no step runs an installed program (a package cannot lie its way into execution)")
    void toolsAndNoInstalledProgram() {
        AgentCliPlan codex = linuxPlan(AgentCliProviderId.CODEX);
        AgentCliPlan claude = linuxPlan(AgentCliProviderId.CLAUDE);

        assertThat(AgentCliStep.SWITCH.in(codex).commandLine()).contains("/agent-cli/codex/");
        assertThat(AgentCliStep.SWITCH.in(claude).commandLine()).contains("/agent-cli/claude/");
        assertThat(codex.commands()).allSatisfy(command -> assertThat(command.commandLine()).doesNotContain("/package/bin").doesNotContain("--version"));
    }

    @Test
    @DisplayName("S3-AG-10 RC-B-625 a Windows plan is PowerShell in encoded lines under the shell's 8000-character limit, and runs tar.exe only for the unpack")
    void windowsCommands() {
        AgentCliPlan plan = windowsPlan(AgentCliProviderId.CODEX);

        assertThat(plan.commands()).allSatisfy(command -> assertThat(command.commandLine()).as(command.label()).startsWith("powershell.exe ").hasSizeLessThanOrEqualTo(8000));
        assertThat(plan.commands()).allSatisfy(command -> assertThat(command.commandLine()).doesNotContain("fixture-request-key"));
    }

    @Test
    @DisplayName("S3-AG-10 the intent decides the tool only: a plan for another provider than its release is refused by the plan itself")
    void planChecksProvider() {
        AgentRelease codex = release(AgentCliProviderId.CODEX);
        AgentCliIntent claudeIntent = fixtures.intent(release(AgentCliProviderId.CLAUDE));

        org.assertj.core.api.Assertions.assertThatThrownBy(() -> linux.agentCliPlan(claudeIntent, codex)).isInstanceOf(IllegalArgumentException.class);
        assertThat(Pattern.matches("[a-z][a-z0-9-]{0,31}", AgentCliStep.CURRENT_AFTER.label())).isTrue();
    }
}
