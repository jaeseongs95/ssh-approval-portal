package io.github.jaeseongs95.portal.server.assembly;

import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.scheduling.annotation.EnableScheduling;

import io.github.jaeseongs95.portal.app.agentcli.AgentCliConfiguration;
import io.github.jaeseongs95.portal.app.config.DomainBeans;
import io.github.jaeseongs95.portal.store.StoreConfiguration;

/**
 * The minimal assembly of stage 3 (decision D3-12): the storage adapters, the helper beans of the domain, and the use cases of the file, artifact, output, storage, agent CLI,
 * history, capacity and lifecycle packages of portal-app. What it does not make is made elsewhere: the {@link StorageSettings} (a test supplies one; stage 4 binds
 * {@code bridge.*}), the ports of the remote side (the SSH adapter, the release catalog, the admission of uploads, the targets) and the use cases of the execution side
 * (implementer C's packages, which the merge adds to the scan below). {@code @EnableScheduling} turns the two reapers on.
 *
 * <p>This class is the one place where portal-store and portal-app meet; portal-ssh is added here when its adapters exist (portal-ssh may not depend on portal-store, so only the
 * server can hold both).
 */
@Configuration(proxyBeanMethods = false)
@Import({StoreConfiguration.class, DomainBeans.class, AgentCliConfiguration.class, StorageBeans.class, StorageStartup.class})
@ComponentScan(basePackages = {"io.github.jaeseongs95.portal.app.artifact", "io.github.jaeseongs95.portal.app.file", "io.github.jaeseongs95.portal.app.output",
    "io.github.jaeseongs95.portal.app.storage", "io.github.jaeseongs95.portal.app.agentcli", "io.github.jaeseongs95.portal.app.history",
    "io.github.jaeseongs95.portal.app.capacity", "io.github.jaeseongs95.portal.app.lifecycle"})
@EnableScheduling
public class PortalAssembly {
}
