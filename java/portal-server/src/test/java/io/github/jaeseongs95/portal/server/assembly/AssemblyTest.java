package io.github.jaeseongs95.portal.server.assembly;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.TestConstructor;

/** One Spring context of the real assembly with fakes at the boundaries ({@link AssemblyTestApplication}) and constructor injection into the test class (no field {@code @Autowired}). */
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
@SpringBootTest(classes = AssemblyTestApplication.class, webEnvironment = SpringBootTest.WebEnvironment.NONE)
@TestConstructor(autowireMode = TestConstructor.AutowireMode.ALL)
@interface AssemblyTest {
}
