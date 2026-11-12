package io.github.jaeseongs95.portal.server.assembly;

import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.FilterType;
import org.springframework.scheduling.annotation.EnableScheduling;

import io.github.jaeseongs95.portal.app.agentcli.AgentCliConfiguration;
import io.github.jaeseongs95.portal.app.config.DomainBeans;
import io.github.jaeseongs95.portal.app.file.OperationUploadAdmission;
import io.github.jaeseongs95.portal.store.StoreConfiguration;

/**
 * The part of the assembly that has no remote side and no execution side (decision D3-12): the storage adapters, the helper beans of the domain, and the use cases of the
 * file, artifact, output, storage, agent CLI, history, capacity and lifecycle packages of portal-app. A test that fakes the SSH boundary and the intake of uploads builds on
 * this class alone; {@link PortalAssembly} is this class with the execution side and the SSH adapter added.
 *
 * <p>{@link OperationUploadAdmission} is the one class of the file package that belongs to the execution side (it needs the request entrance and the operation intake), so
 * the scan leaves it out and {@link ExecutionAssembly} imports it. {@code @EnableScheduling} turns the two reapers on. The {@link StorageSettings} are not made here: a test
 * supplies them, {@link DefaultAssembly} reads them from the files of the installation, and stage 4 binds {@code bridge.*}.
 */
@Configuration(proxyBeanMethods = false)
@Import({StoreConfiguration.class, DomainBeans.class, AgentCliConfiguration.class, StorageBeans.class, StorageStartup.class})
@ComponentScan(basePackages = {"io.github.jaeseongs95.portal.app.artifact", "io.github.jaeseongs95.portal.app.file", "io.github.jaeseongs95.portal.app.output",
    "io.github.jaeseongs95.portal.app.storage", "io.github.jaeseongs95.portal.app.agentcli", "io.github.jaeseongs95.portal.app.history",
    "io.github.jaeseongs95.portal.app.capacity", "io.github.jaeseongs95.portal.app.lifecycle"},
    excludeFilters = @ComponentScan.Filter(type = FilterType.ASSIGNABLE_TYPE, classes = OperationUploadAdmission.class))
@EnableScheduling
public class CoreAssembly {
}
