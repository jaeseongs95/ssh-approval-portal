package io.github.jaeseongs95.portal.server.usecase;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.data.jdbc.test.autoconfigure.DataJdbcTest;
import org.springframework.boot.flyway.autoconfigure.FlywayAutoConfiguration;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.TestConstructor;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * The slice of the use case tests: the real storage adapters of portal-store (the journal, the claim store, the output stores, the maintenance and policy stores) on an
 * embedded H2 database without a compatibility mode and with the real Flyway migration of the product, the real use case beans of portal-app, and plain test classes at the
 * two boundaries that no module of this assembly tests: the SSH executor and the target platform ({@link UseCaseWiring}). The tests are in portal-server because that is the
 * module that sees both portal-app and portal-store (rule A-DIR: portal-app does not depend on portal-store, not even for tests). Constructor injection into the test class
 * (no field {@code @Autowired}).
 *
 * <p>The slice does <em>not</em> roll a test back: the dispatcher works on other threads, which must see the rows. A test therefore makes its own keys and its own
 * targets' operations, and leaves no operation waiting or running behind it.
 */
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
@DataJdbcTest(properties = "spring.flyway.locations=classpath:db/migration/common,classpath:db/migration/{vendor}")
@ImportAutoConfiguration(FlywayAutoConfiguration.class)
@Import(UseCaseWiring.class)
@TestConstructor(autowireMode = TestConstructor.AutowireMode.ALL)
@Transactional(propagation = Propagation.NOT_SUPPORTED)
public @interface UseCaseTest {
}
