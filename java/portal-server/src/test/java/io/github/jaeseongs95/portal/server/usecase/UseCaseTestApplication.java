package io.github.jaeseongs95.portal.server.usecase;

import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * The configuration class the use case slice tests find by looking upwards from the test package ({@code @DataJdbcTest} needs a {@code @SpringBootConfiguration}). It is the
 * nearest one for the tests of this package only; the tests build their context from {@link UseCaseTest}, which imports the wiring explicitly.
 */
@SpringBootApplication
class UseCaseTestApplication {
}
