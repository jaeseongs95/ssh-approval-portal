package io.github.jaeseongs95.portal.ssh.platform;

import io.github.jaeseongs95.portal.app.remote.AgentCliPlan;
import io.github.jaeseongs95.portal.app.remote.FixedRemoteCommand;
import java.util.List;
import java.util.Objects;

/**
 * The fixed commands of an agent CLI installation, by the part they play (stage 3 design 6.2). A target platform makes one {@link FixedRemoteCommand} for each step
 * ({@code TargetPlatform#agentCliPlan}); the installer finds them in the plan by the label of the step and decides when to run which. The meaning of each step is the
 * same on every platform, the text of the command is the platform's: a POSIX target runs {@code sh} commands, a Windows target PowerShell.
 */
public enum AgentCliStep {
    /** Prints the absolute path the package file goes to, in the target's own syntax (the installer uploads it there over SFTP). */
    TARBALL_PATH("tarball-path"),
    /** Prints the absolute path of the directory this version is installed in. */
    FINAL_PATH("final-path"),
    /** Prints where {@code current} points now; prints nothing when there is no current version. Read only. */
    CURRENT_BEFORE("current-before"),
    /** Makes the directory the package file goes to. */
    PREPARE("prepare"),
    /** Unpacks the package and moves the unpacked directory to its final name. */
    UNPACK("unpack"),
    /** Prints the version the unpacked package says it is (read from its metadata file; no installed program is run). Read only. */
    VERSION("version"),
    /** Keeps where {@code current} points now, so that the switch can be undone. */
    KEEP_PREVIOUS("keep-previous"),
    /** Makes {@code current} point to the new version. */
    SWITCH("switch"),
    /** Prints where {@code current} points now (the read that confirms the switch). Read only. */
    CURRENT_AFTER("current-after"),
    /** Puts {@code current} back to the version that was kept. */
    ROLLBACK("rollback"),
    /** Removes {@code current}: the state before the first installation. */
    ROLLBACK_NONE("rollback-none"),
    /** Removes what {@link #KEEP_PREVIOUS} kept. */
    DROP_PREVIOUS("drop-previous"),
    /** Removes the partial directory of this version. */
    CLEANUP("cleanup");

    private final String label;

    AgentCliStep(String label) {
        this.label = label;
    }

    /** The label of the command of this step in a plan. */
    public String label() {
        return label;
    }

    /** The command of this step in the plan; a plan that lacks a step is a programming error of the platform that made it. */
    public FixedRemoteCommand in(AgentCliPlan plan) {
        Objects.requireNonNull(plan, "plan");
        List<FixedRemoteCommand> matching = plan.commands().stream().filter(command -> command.label().equals(label)).toList();
        if (matching.size() != 1) {
            throw new IllegalStateException("The agent CLI plan has " + matching.size() + " commands for the step " + label);
        }
        return matching.get(0);
    }
}
