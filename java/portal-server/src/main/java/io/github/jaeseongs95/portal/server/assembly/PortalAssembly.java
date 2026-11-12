package io.github.jaeseongs95.portal.server.assembly;

import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;

/**
 * The assembly of the product (decision D3-12): the storage adapters and the file, artifact, output, agent CLI, history, capacity and lifecycle use cases
 * ({@link CoreAssembly}), the execution side ({@link ExecutionAssembly}) and the SSH adapter ({@link SshAssembly}). It makes none of the values the parts ask for: the
 * {@link StorageSettings}, the SSH settings, the profiles, the limits, the targets and the pools are the beans of the application that imports it. {@link DefaultAssembly} is
 * that application for the product until stage 4 binds {@code bridge.*}; a test imports this class and makes the values it needs.
 */
@Configuration(proxyBeanMethods = false)
@Import({CoreAssembly.class, ExecutionAssembly.class, SshAssembly.class})
public class PortalAssembly {
}
