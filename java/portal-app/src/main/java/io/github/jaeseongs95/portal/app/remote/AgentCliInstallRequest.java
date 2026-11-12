package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

/**
 * One installation. The use case has checked the intent, the target revision and the expiry, and has fetched the package; the adapter checks the package against the
 * release's checksum before it sends anything.
 *
 * @param target where to install
 * @param plan the release and the fixed commands
 * @param tarball the package bytes the use case fetched
 * @param limits the time limit and the largest package
 */
public record AgentCliInstallRequest(RemoteTarget target, AgentCliPlan plan, PayloadSource tarball, TransferLimits limits) {

    public AgentCliInstallRequest {
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(plan, "plan");
        Objects.requireNonNull(tarball, "tarball");
        Objects.requireNonNull(limits, "limits");
    }
}
