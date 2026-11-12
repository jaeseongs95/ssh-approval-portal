package io.github.jaeseongs95.portal.app.agentcli;

import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;

/**
 * Where the package of an announced release comes from (stage 3 design 6.2, decision D3-01). The implementation is an adapter of stage 4 (the public registry, over an
 * HTTP client); stage 3 names only what the installation use case needs and tries it with a plain fake. The catalog hands over bytes and nothing else: the checksum of the
 * package is checked by the installer against the release the owner approved, so a catalog that answers wrong bytes cannot get them installed.
 */
public interface AgentReleaseCatalog {

    /** The package of the release: its bytes to read, or that they cannot be had now. Nothing is thrown for a registry that is down. */
    TarballResult fetch(AgentRelease release);
}
