package io.github.jaeseongs95.portal.store;

import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * The configuration class the slice tests find by looking upwards from the test package ({@code @DataJdbcTest} needs a {@code @SpringBootConfiguration}); the
 * module has no application class of its own. It sits in the package of the storage adapter, so Spring Data JDBC finds the repositories below it.
 */
@SpringBootApplication
class StoreTestApplication {
}
