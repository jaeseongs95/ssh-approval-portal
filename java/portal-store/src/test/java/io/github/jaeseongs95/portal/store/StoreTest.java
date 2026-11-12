package io.github.jaeseongs95.portal.store;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

import org.springframework.boot.data.jdbc.test.autoconfigure.DataJdbcTest;
import org.springframework.boot.flyway.autoconfigure.FlywayAutoConfiguration;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.TestConstructor;

import io.github.jaeseongs95.portal.store.external.ExternalDbmsFlywayConfiguration;

/**
 * The storage test slice (Principles 7.2, 7.3): {@code @DataJdbcTest} on an embedded H2 database without a compatibility mode, with the real Flyway migration of the
 * product applied ({@code db/migration/common} plus the scripts of the vendor {@code h2}), and constructor injection into the test class (no field
 * {@code @Autowired}). The slice rolls each test back; a test that needs commits from several threads declares
 * {@code @Transactional(propagation = Propagation.NOT_SUPPORTED)} and cleans its rows itself.
 *
 * <p>The same slice runs on an external DBMS in the Gradle task {@code externalDbmsTest}: its system properties make {@code ExternalDbmsEnvironment} (test resources,
 * {@code META-INF/spring.factories}) replace the datasource and turn the embedded database off ({@code spring.test.database.replace=none}), and
 * {@link ExternalDbmsFlywayConfiguration} cleans the test schema before each context migrates. Without those properties (the default run) both do nothing.
 */
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
@DataJdbcTest(properties = "spring.flyway.locations=classpath:db/migration/common,classpath:db/migration/{vendor}")
@ImportAutoConfiguration(FlywayAutoConfiguration.class)
@Import({IdentifierQuoting.class, Savepoints.class, ExternalDbmsFlywayConfiguration.class})
@TestConstructor(autowireMode = TestConstructor.AutowireMode.ALL)
public @interface StoreTest {
}
