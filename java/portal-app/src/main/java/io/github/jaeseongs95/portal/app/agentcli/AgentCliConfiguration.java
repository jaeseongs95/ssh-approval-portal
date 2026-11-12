package io.github.jaeseongs95.portal.app.agentcli;

import java.util.List;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import io.github.jaeseongs95.portal.domain.agentcli.AgentCliCatalog;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProvider;
import io.github.jaeseongs95.portal.domain.agentcli.ClaudeCliProvider;
import io.github.jaeseongs95.portal.domain.agentcli.CodexCliProvider;

/**
 * Registers the providers and the catalog of agent tools. Why {@code @Bean} methods and not stereotypes (Principles 3.1): {@code ClaudeCliProvider},
 * {@code CodexCliProvider} and {@code AgentCliCatalog} are classes of portal-domain, which may not carry a Spring annotation (rule A-DOMAIN), so this configuration is the one
 * place that turns them into beans. A new tool is a new provider bean; the catalog collects every {@link AgentCliProvider} bean (design patterns 8.12), so nothing here changes.
 */
@Configuration(proxyBeanMethods = false)
public class AgentCliConfiguration {

    @Bean
    public CodexCliProvider codexCliProvider() {
        return new CodexCliProvider();
    }

    @Bean
    public ClaudeCliProvider claudeCliProvider() {
        return new ClaudeCliProvider();
    }

    @Bean
    public AgentCliCatalog agentCliCatalog(List<AgentCliProvider> providers) {
        return new AgentCliCatalog(providers);
    }
}
