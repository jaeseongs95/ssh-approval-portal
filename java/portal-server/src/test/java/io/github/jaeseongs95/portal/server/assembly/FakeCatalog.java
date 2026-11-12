package io.github.jaeseongs95.portal.server.assembly;

import java.util.ArrayList;
import java.util.List;

import io.github.jaeseongs95.portal.app.agentcli.AgentReleaseCatalog;
import io.github.jaeseongs95.portal.app.agentcli.TarballResult;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;

/**
 * The registry of the assembly tests: serves a package, or says it is unavailable. It owns the call log that the fake installer writes into as well, so a test can read the
 * order in which the use case called the catalog and the installer.
 */
final class FakeCatalog implements AgentReleaseCatalog {

    final List<String> log = new ArrayList<>();
    boolean available = true;

    void reset() {
        log.clear();
        available = true;
    }

    @Override
    public TarballResult fetch(AgentRelease release) {
        log.add("catalog.fetch");
        if (!available) {
            return new TarballResult.Unavailable();
        }
        return new TarballResult.Fetched(() -> {
            throw new IllegalStateException("The fake installer does not read the package");
        });
    }
}
