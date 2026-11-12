package io.github.jaeseongs95.portal.server.assembly;

import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;

/**
 * The application of the product until stage 4: the {@link PortalAssembly} with the default values of {@link AssemblyDefaults}. It still needs two values that only the
 * installation can give, the {@link StorageSettings} and the {@link ConnectionFiles}; stage 4 makes both from {@code bridge.*} and then replaces the defaults by the binding.
 */
@Configuration(proxyBeanMethods = false)
@Import({PortalAssembly.class, AssemblyDefaults.class})
public class DefaultAssembly {
}
