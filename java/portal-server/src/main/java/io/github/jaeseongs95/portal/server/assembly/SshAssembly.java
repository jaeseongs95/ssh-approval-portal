package io.github.jaeseongs95.portal.server.assembly;

import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.Configuration;

/**
 * The SSH adapter of the assembly: the beans of the session, exec, sftp, platform, cli, profile and hostkey packages of portal-ssh (the session pool, the executor, the file
 * transfer, the two target platforms, the agent CLI installer, the profile registry and the credentials, the host key policy). portal-ssh may not depend on portal-store, so
 * it is only here, in the module that sees both, that the adapter and the use cases that call its ports meet. The settings it asks for ({@code SshSettings},
 * {@code SessionReapSettings}, {@code ProfileCatalog}, {@code FilePathPolicy}) are made by {@link DefaultAssembly} or by a test.
 */
@Configuration(proxyBeanMethods = false)
@ComponentScan(basePackages = {"io.github.jaeseongs95.portal.ssh.session", "io.github.jaeseongs95.portal.ssh.exec", "io.github.jaeseongs95.portal.ssh.sftp",
    "io.github.jaeseongs95.portal.ssh.platform", "io.github.jaeseongs95.portal.ssh.cli", "io.github.jaeseongs95.portal.ssh.profile", "io.github.jaeseongs95.portal.ssh.hostkey"})
public class SshAssembly {
}
