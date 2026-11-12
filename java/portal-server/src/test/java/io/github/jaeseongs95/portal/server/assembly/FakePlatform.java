package io.github.jaeseongs95.portal.server.assembly;

import java.util.List;
import java.util.Objects;

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
import io.github.jaeseongs95.portal.app.remote.UnsupportedReason;
import io.github.jaeseongs95.portal.app.remote.WorkingDirectory;
import io.github.jaeseongs95.portal.app.target.TargetPlatform;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliIntent;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;
import io.github.jaeseongs95.portal.domain.classify.CommandClassification;
import io.github.jaeseongs95.portal.domain.command.CommandLineGrammar;
import io.github.jaeseongs95.portal.domain.command.TargetRule;
import io.github.jaeseongs95.portal.domain.path.PathSyntax;
import io.github.jaeseongs95.portal.domain.target.Target;
import io.github.jaeseongs95.portal.domain.target.TargetCapabilities;
import io.github.jaeseongs95.portal.domain.target.TargetOs;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.SourceText;

/**
 * The operating system boundary of the assembly tests: only what the file and agent CLI use cases ask of a platform is answered (the others fail the test loudly). The two
 * real platforms are beans of portal-ssh. The Windows one cannot set permission bits and has no elevation, like the real one (design 4.6).
 */
final class FakePlatform implements TargetPlatform {

    private final TargetOs os;

    FakePlatform(TargetOs os) {
        this.os = Objects.requireNonNull(os, "os");
    }

    @Override
    public TargetOs os() {
        return os;
    }

    @Override
    public PathSyntax pathSyntax() {
        return os == TargetOs.WINDOWS ? PathSyntax.WINDOWS : PathSyntax.POSIX;
    }

    @Override
    public TargetCapabilities capabilities(Target target) {
        return target.capabilities();
    }

    @Override
    public CommandClassification classify(CommandText command) {
        throw new IllegalStateException("The file use cases do not classify commands");
    }

    @Override
    public CommandLineGrammar commandLineGrammar() {
        throw new IllegalStateException("The file use cases do not read command names");
    }

    @Override
    public boolean deniesName(TargetRule rule, CommandText command) {
        return false;
    }

    @Override
    public PreparedCommand prepareCommand(CommandText command, WorkingDirectory workdir) {
        return new PreparedCommand(command.value(), StdinBytes.none(), CommandKind.COMMAND);
    }

    @Override
    public PreparedCommand prepareSource(SourceText source, SourceArguments args, WorkingDirectory workdir) {
        throw new IllegalStateException("The file use cases do not prepare sources");
    }

    @Override
    public PathPolicyBinding pathPolicy(Target target) {
        return new PathPolicyBinding.NoRootPolicy();
    }

    @Override
    public PermissionSupport permissionSupport() {
        return os == TargetOs.WINDOWS ? new PermissionSupport.Unsupported(UnsupportedReason.WINDOWS_SFTP_CHMOD) : new PermissionSupport.Supported();
    }

    @Override
    public ElevationPlan elevationPlan() {
        return os == TargetOs.WINDOWS ? new ElevationPlan.NotSupported()
            : new ElevationPlan.SudoNonInteractive(new FixedRemoteCommand("sudo-probe", "sudo -n true"));
    }

    @Override
    public AgentCliPlan agentCliPlan(AgentCliIntent intent, AgentRelease release) {
        return new AgentCliPlan(release.provider(), release, List.of(new FixedRemoteCommand("unpack", "tar -xzf package.tgz")));
    }

    @Override
    public ExecReply execReply() {
        return ExecReply.AWAITED;
    }
}
