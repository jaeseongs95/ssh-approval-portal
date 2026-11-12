package io.github.jaeseongs95.portal.store;

import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.jdbc.repository.config.EnableJdbcRepositories;

/**
 * Turns the storage adapter on: the Spring Data JDBC repositories of every package under {@code ...portal.store} and the {@code @Repository} / {@code @Component}
 * adapters next to them. The application that assembles the product imports this class (or scans the package); Boot's own repository auto-configuration looks at
 * the package of the application class only, and that package is not this one, which is why the repositories are enabled here by name.
 */
@Configuration(proxyBeanMethods = false)
@ComponentScan
@EnableJdbcRepositories
public class StoreConfiguration {
}
