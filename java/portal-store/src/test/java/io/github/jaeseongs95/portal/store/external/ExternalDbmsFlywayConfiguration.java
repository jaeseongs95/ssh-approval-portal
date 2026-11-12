package io.github.jaeseongs95.portal.store.external;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.flyway.autoconfigure.FlywayMigrationStrategy;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;

/**
 * On an external DBMS every Spring context of the storage tests starts from an empty test schema, the way the embedded H2 database of each context does: the Flyway
 * migration of the context cleans the schema first ({@code FlywayMigrationStrategy}, https://docs.spring.io/spring-boot/how-to/data-initialization.html, "Use a Higher-level
 * Database Migration Tool", Flyway). Committed rows of one test class (the tests with several threads commit) can therefore not reach another test class through a context
 * that is created later. The clean runs only after {@link ExternalDbms#requireOnlyTheTestSchema} has checked that Flyway is confined to the test schema, because
 * {@code Flyway.clean()} drops every object of the schemas it is configured for. On the default run on H2 the condition is false and the bean does not exist.
 */
@TestConfiguration(proxyBeanMethods = false)
@ConditionalOnProperty(ExternalDbms.URL)
public class ExternalDbmsFlywayConfiguration {

    @Bean
    FlywayMigrationStrategy cleanTheTestSchemaThenMigrate() {
        ExternalDbms dbms = ExternalDbms.fromSystemProperties().orElseThrow(() -> new IllegalStateException(ExternalDbms.URL + " is not set"));
        return flyway -> {
            dbms.requireOnlyTheTestSchema(flyway.getConfiguration().getDefaultSchema(), flyway.getConfiguration().getSchemas());
            flyway.clean();
            flyway.migrate();
        };
    }
}
