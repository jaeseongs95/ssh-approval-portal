package io.github.jaeseongs95.portal.server.assembly;

import java.time.Instant;
import java.util.List;

import io.github.jaeseongs95.portal.app.cli.CliVersion;
import io.github.jaeseongs95.portal.app.remote.AgentCliInstallRequest;
import io.github.jaeseongs95.portal.app.remote.AgentCliInstallResult;
import io.github.jaeseongs95.portal.app.remote.AgentCliInstallerPort;
import io.github.jaeseongs95.portal.app.remote.AgentCliStatusRequest;
import io.github.jaeseongs95.portal.app.remote.AgentCliStatusResult;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;

/** The installer of the assembly tests (the SSH side of an agent CLI installation): answers what the test says and writes every call into the shared call log. */
final class FakeInstaller implements AgentCliInstallerPort {

    private final List<String> log;
    AgentCliInstallResult answer;

    FakeInstaller(List<String> log) {
        this.log = log;
        reset();
    }

    void reset() {
        answer = new AgentCliInstallResult.Installed(new CliVersion("1.2.3"), 0, Instant.parse("2026-11-12T00:00:00Z"));
    }

    @Override
    public AgentCliInstallResult install(AgentCliInstallRequest request, ExecutionControl control) {
        log.add("installer.install");
        return answer;
    }

    @Override
    public AgentCliStatusResult status(AgentCliStatusRequest request, ExecutionControl control) {
        throw new IllegalStateException("The use case under test does not ask for a status");
    }
}
