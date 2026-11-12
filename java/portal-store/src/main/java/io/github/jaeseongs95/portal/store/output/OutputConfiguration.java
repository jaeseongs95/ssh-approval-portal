package io.github.jaeseongs95.portal.store.output;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Registers the limits of the output store. Why a {@code @Bean} method and not a stereotype (Principles 3.1): {@link OutputLimits} is a value record whose
 * components are numbers, so the container cannot build it by constructor injection; the limits are constants of the product (2.x had no setting for them), and
 * this method is the one place that turns them into a bean. The server's assembly (stage 3, D3-12) therefore does not register a second {@code OutputLimits}; the binding of
 * settings to these numbers is stage 4's, and then this bean is the one that moves to the server.
 */
@Configuration(proxyBeanMethods = false)
public class OutputConfiguration {

    @Bean
    public OutputLimits outputLimits() {
        return OutputLimits.defaults();
    }
}
