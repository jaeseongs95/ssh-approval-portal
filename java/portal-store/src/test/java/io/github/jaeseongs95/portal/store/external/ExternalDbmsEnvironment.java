package io.github.jaeseongs95.portal.store.external;

import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.boot.EnvironmentPostProcessor;
import org.springframework.boot.SpringApplication;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.PropertySource;

/**
 * Points the Spring context of a storage test at the external DBMS of {@link ExternalDbms} and supplies its password; it does nothing when the run is the default one
 * on H2.
 *
 * <p>Why an {@code EnvironmentPostProcessor}: the password must reach {@code spring.datasource.password} without being a Gradle input, a command line argument or a
 * system property (all of which would show it to the build, to the process list or to a test report). The Spring Boot way to add a property source before the context is
 * created is an {@code EnvironmentPostProcessor} registered in {@code META-INF/spring.factories} (src/test/resources here, so it exists only for tests)
 * (https://docs.spring.io/spring-boot/how-to/application.html, "Customize the Environment or ApplicationContext Before It Starts"). In Spring Boot 4 the interface is
 * {@code org.springframework.boot.EnvironmentPostProcessor} (it was {@code org.springframework.boot.env.EnvironmentPostProcessor}, now deprecated) and the
 * {@code spring.factories} key is the new name; checked against spring-boot-4.1.2.jar (Spring Boot 4.0 Migration Guide, https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide).
 *
 * <p>The properties it adds:
 * <ul>
 * <li>{@code spring.datasource.url}, {@code .username}: from the system properties; {@code .password}: read from the password file when the datasource binds it
 * ({@link PasswordPropertySource});</li>
 * <li>{@code spring.test.database.replace=none}: {@code @DataJdbcTest} keeps this datasource and does not swap in an embedded database
 * ({@code @AutoConfigureTestDatabase}, {@code spring.test.database.replace}; the annotation's own default is not mapped to a property, so the property decides);</li>
 * <li>{@code spring.datasource.hikari.maximum-pool-size=4} and {@code minimum-idle=1}: the account has a connection limit of 10, and a cached test context holds a pool;</li>
 * <li>{@code spring.datasource.hikari.schema}: every connection of the pool works in the test schema (JDBC {@code Connection#setSchema}); the tables of the product are
 * created there by Flyway ({@code spring.flyway.default-schema}) and found there by the unquoted names of the tests;</li>
 * <li>{@code spring.flyway.clean-disabled=false}: {@link ExternalDbmsFlywayConfiguration} cleans the test schema before each context migrates, as the embedded H2 database
 * of each context starts empty.</li>
 * </ul>
 */
public final class ExternalDbmsEnvironment implements EnvironmentPostProcessor {

    static final String PASSWORD_KEY = "spring.datasource.password";

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        ExternalDbms.fromSystemProperties().ifPresent(dbms -> register(environment, dbms));
    }

    /** Adds the property sources of the external DBMS to the environment, in front of every other source. */
    void register(ConfigurableEnvironment environment, ExternalDbms dbms) {
        Map<String, Object> settings = new LinkedHashMap<>();
        settings.put("spring.datasource.url", dbms.url());
        settings.put("spring.datasource.username", dbms.user());
        settings.put("spring.test.database.replace", "none");
        settings.put("spring.datasource.hikari.maximum-pool-size", "4");
        settings.put("spring.datasource.hikari.minimum-idle", "1");
        settings.put("spring.datasource.hikari.schema", dbms.schema());
        settings.put("spring.flyway.default-schema", dbms.schema());
        settings.put("spring.flyway.clean-disabled", "false");
        environment.getPropertySources().addFirst(new MapPropertySource("portalExternalDbms", settings));
        environment.getPropertySources().addFirst(new PasswordPropertySource(dbms));
    }

    /**
     * A property source that answers {@code spring.datasource.password} from the password file and nothing else. It is not a {@code MapPropertySource} on purpose: that
     * class prints its whole map in {@code toString()} when debug logging is on, and the map would hold the password.
     */
    static final class PasswordPropertySource extends PropertySource<ExternalDbms> {

        PasswordPropertySource(ExternalDbms source) {
            super("portalExternalDbmsPassword", source);
        }

        @Override
        public Object getProperty(String name) {
            return PASSWORD_KEY.equals(name) ? getSource().password() : null;
        }

        @Override
        public String toString() {
            return "PasswordPropertySource {name='" + getName() + "'}";
        }
    }
}
