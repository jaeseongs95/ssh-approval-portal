package io.github.jaeseongs95.portal.app.target;

import io.github.jaeseongs95.portal.app.remote.AgentCliPlan;
import io.github.jaeseongs95.portal.app.remote.ElevationPlan;
import io.github.jaeseongs95.portal.app.remote.ExecReply;
import io.github.jaeseongs95.portal.app.remote.PathPolicyBinding;
import io.github.jaeseongs95.portal.app.remote.PermissionSupport;
import io.github.jaeseongs95.portal.app.remote.PreparedCommand;
import io.github.jaeseongs95.portal.app.remote.SourceArguments;
import io.github.jaeseongs95.portal.app.remote.WorkingDirectory;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliIntent;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;
import io.github.jaeseongs95.portal.domain.classify.CommandClass;
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
 * What differs between the operating systems of a <em>target</em> (not of this server): the path grammar, the capabilities, how a command is classified and how
 * its names are read, how a command or a script is made ready for the target's shell, and what the target can do for files and installations. One implementation per
 * {@link TargetOs} ({@code LinuxTargetPlatform}, {@code WindowsTargetPlatform}) is a bean of portal-ssh (stage 3); {@link TargetPlatformRegistry} collects them.
 * A caller that needs a capability the target lacks reads {@link #capabilities(Target)} and refuses with {@code RequestRefusedException(TARGET_CAPABILITY_UNSUPPORTED)};
 * an implementation never throws {@code UnsupportedOperationException} (rule A-LSP) and answers a capability it lacks with the value of its sealed result type.
 */
public interface TargetPlatform {

    /** The identification value the registry keys the implementations by. */
    TargetOs os();

    /** Which {@code RemotePath} variant a path on this target is written in; {@link PathSyntax#path(String)} makes it. */
    PathSyntax pathSyntax();

    /** 2.x {@code targetCapabilities} ({@code target-platform.mjs:8-14}). */
    TargetCapabilities capabilities(Target target);

    /** 2.x {@code classifyForTarget}: Linux delegates to the command classifier, Windows answers {@link CommandClass#READ_ONLY} for two cmdlets and {@link CommandClass#SAFE} otherwise. */
    CommandClassification classify(CommandText command);

    /** 2.x {@code commandNamesForTarget}. */
    CommandLineGrammar commandLineGrammar();

    /** 2.x {@code deniedForTarget}: Windows compares the lower-cased last path segment, Linux asks {@code TargetRule#denies}. */
    boolean deniesName(TargetRule rule, CommandText command);

    /**
     * The command in the form the target's shell takes it (stage 3 design 2.3): Linux changes into the working directory and passes the text on, Windows wraps it for
     * PowerShell with an encoded command and silences the progress records (2.x {@code windows-command.mjs}). A line the target cannot take, a Windows line over its
     * 8000 characters, is refused with {@code RequestRefusedException(WINDOWS_COMMAND_TOO_LARGE)}.
     */
    PreparedCommand prepareCommand(CommandText command, WorkingDirectory workdir);

    /**
     * A script run as a command: the receiver is a fixed program that takes the source on its standard input, checks its bytes and digest, and only then runs it
     * (python-source-v1). The source and the arguments are data for the receiver; no part of them is in the command line.
     */
    PreparedCommand prepareSource(SourceText source, SourceArguments args, WorkingDirectory workdir);

    /** Whether the target has an allowed-root rule for file paths and in which syntax it is compared: none on Linux, the root comparison on Windows. */
    PathPolicyBinding pathPolicy(Target target);

    /** Whether the target can set permission bits: Linux yes, Windows no (its SFTP server has no {@code chmod}). */
    PermissionSupport permissionSupport();

    /** How the target is asked for elevated rights; {@code ElevationPlan.NotSupported} when it has none. */
    ElevationPlan elevationPlan();

    /**
     * The release and the fixed commands that install an agent CLI on this kind of target. It is only called for a target whose {@link #capabilities(Target)} say
     * {@code agentCli}.
     */
    AgentCliPlan agentCliPlan(AgentCliIntent intent, AgentRelease release);

    /**
     * Whether the server of this kind of target answers the {@code exec} request (decision D3-06). A platform whose server does not answer returns
     * {@link ExecReply#NOT_AWAITED}, so a failure after the request is never mistaken for a refusal.
     */
    ExecReply execReply();
}
