package io.github.jaeseongs95.portal.server.assembly;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.TestConstructor;

/**
 * One Spring context of the whole product ({@link FullAssemblyApplication}: the real stores, use cases, dispatcher and SSH adapter, the default values of the assembly) in front
 * of a real SSH server that runs in the test JVM, and constructor injection into the test class (no field {@code @Autowired}). The password the profiles log in with is
 * read from {@code SSH_MCP_PASSWORD} of the Spring environment, as the product reads it.
 */
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
@SpringBootTest(classes = FullAssemblyApplication.class, webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = "SSH_MCP_PASSWORD=" + FullAssemblyApplication.PASSWORD)
@TestConstructor(autowireMode = TestConstructor.AutowireMode.ALL)
@interface FullAssemblyTest {
}
