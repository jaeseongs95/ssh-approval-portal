package io.github.jaeseongs95.portal.ssh.platform;

import io.github.jaeseongs95.portal.app.remote.AgentCliPlan;
import io.github.jaeseongs95.portal.app.remote.FixedRemoteCommand;
import java.util.List;
import java.util.Objects;

/**
 * The commands of an agent CLI installation that are run on the target (stage 3 design 6.2). There is one: unpacking the package. Everything else the installer does
 * (the directories, the reading of the current version, the version in the package's metadata, the switch of {@code current}, the removals) is SFTP and Java, and is
 * not a command. The unpacking stays a command of the target because the target unpacks the whole archive at once and keeps the modes of its files, where Java would
 * have to put thousands of files one by one over SFTP; {@code tar} (Windows: {@code tar.exe}) is an external program of the target and Java cannot replace it there
 * (docs/external-programs). A target platform makes the command ({@code TargetPlatform#agentCliPlan}); the installer finds it in the plan by the label.
 */
public enum AgentCliStep {
    /** Unpacks {@code package.tgz} in the partial directory of the release; ends with the exit code of {@code tar}. */
    UNPACK("unpack");

    private final String label;

    AgentCliStep(String label) {
        this.label = label;
    }

    /** The label of the command of this step in a plan. */
    public String label() {
        return label;
    }

    /** The command of this step in the plan; a plan that lacks it is a programming error of the platform that made it. */
    public FixedRemoteCommand in(AgentCliPlan plan) {
        Objects.requireNonNull(plan, "plan");
        List<FixedRemoteCommand> matching = plan.commands().stream().filter(command -> command.label().equals(label)).toList();
        if (matching.size() != 1) {
            throw new IllegalStateException("The agent CLI plan has " + matching.size() + " commands for the step " + label);
        }
        return matching.get(0);
    }
}
