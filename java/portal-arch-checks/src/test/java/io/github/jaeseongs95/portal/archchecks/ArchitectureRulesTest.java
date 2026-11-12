package io.github.jaeseongs95.portal.archchecks;

import static org.assertj.core.api.Assertions.assertThat;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.lang.ArchRule;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.TestInstance.Lifecycle;

/**
 * The design rules over the product: every class of every product module (portal-domain ... portal-migrate), their Java sources and their build files.
 * Cases A-* of docs/migration/foundation-cases.md; RuleFixturesTest proves that each rule can fail.
 */
@TestInstance(Lifecycle.PER_CLASS)
class ArchitectureRulesTest {

    private static final ModuleTable TABLE = ModuleTable.product();
    private static final SourceRules SOURCES = new SourceRules(TABLE);

    // One import for the whole class (PER_CLASS lifecycle): instance fields, not static state.
    private JavaClasses product;
    private Path root;
    private List<String> modules;

    @BeforeAll
    void importProduct() {
        // System.getProperty is allowed here: a JUnit test outside Spring reads the value Gradle's systemProperty sets; A-ENV and Principles 3.5 bind the product code.
        root = Path.of(System.getProperty("portal.arch.root"));
        modules = List.of(System.getProperty("portal.arch.modules").split(","));
        Path[] classDirectories = Arrays.stream(System.getProperty("portal.arch.classes").split(",")).map(Path::of).filter(Files::isDirectory).toArray(Path[]::new);
        product = new ClassFileImporter().importPaths(classDirectories);
    }

    @Test
    void theProductClassesWereImported() {
        assertThat(modules).contains("portal-domain", "portal-app", "portal-store", "portal-ssh", "portal-desktop", "portal-web", "portal-server", "portal-client", "portal-migrate");
        assertThat(product.contain("io.github.jaeseongs95.portal.server.PortalServerApplication"))
            .as("the product classes were imported: a rule over nothing proves nothing").isTrue();
    }

    @Test
    void a_out_noStandardStreams() {
        check(PortalRules.out());
    }

    @Test
    void a_stack_noPrintStackTrace() {
        check(PortalRules.stack());
    }

    @Test
    void a_value_noValueAnnotation() {
        check(PortalRules.value());
    }

    @Test
    void a_env_noEnvironmentOrSystemProperty() {
        check(PortalRules.env());
    }

    @Test
    void a_json_noOwnJsonMapper() {
        check(PortalRules.json());
    }

    @Test
    void a_string_noStringCopyOrIntern() {
        check(PortalRules.string());
    }

    @Test
    void a_jdbc_noOwnJdbcAccess() {
        check(PortalRules.jdbc());
    }

    @Test
    void a_web_oneAdviceAndRecordBoundaries() {
        check(PortalRules.web());
        long advices = product.stream().filter(c -> c.isAnnotatedWith("org.springframework.web.bind.annotation.RestControllerAdvice")
            || c.isAnnotatedWith("org.springframework.web.bind.annotation.ControllerAdvice")).count();
        assertThat(advices).as("at most one controller advice (Principles 3.8)").isLessThanOrEqualTo(1);
    }

    @Test
    void a_util_noStaticOnlyBusinessHelpers() {
        check(PortalRules.util());
    }

    @Test
    void a_dip_noGetBean() {
        check(PortalRules.dependencyInjection());
    }

    @Test
    void a_encap_noPublicMutableFields() {
        check(PortalRules.encapsulation());
    }

    @Test
    void a_lsp_noUnsupportedOperation() {
        check(PortalRules.unsupported());
    }

    @Test
    void a_time_noWallClockWithoutClock() {
        check(PortalRules.time());
    }

    @Test
    void a_os_noOperatingSystemJudgement() {
        check(PortalRules.os());
        assertThat(sourceViolations("A-OS")).isEmpty();
    }

    @Test
    void a_thread_noOwnThreads() {
        check(PortalRules.thread());
    }

    @Test
    void a_process_onlyListedClassesStartProcesses() {
        check(PortalRules.process(PortalRules.PROCESS_ALLOWED));
    }

    @Test
    void a_dir_moduleDependencyDirection() {
        check(PortalRules.direction(TABLE));
        assertThat(buildFileViolations("A-DIR")).isEmpty();
    }

    @Test
    void a_domain_domainDependsOnTheJdkOnly() {
        check(PortalRules.domain(TABLE));
    }

    @Test
    void a_cycle_noPackageCycleInAnyModule() {
        check(PortalRules.cycles(TABLE.mayUse().keySet().stream().sorted().map(TABLE::packageOf).toList()));
    }

    @Test
    void a_lombok_noLombok() {
        check(PortalRules.lombok());
        assertThat(sourceViolations("A-LOMBOK")).isEmpty();
        assertThat(buildFileViolations("A-LOMBOK")).isEmpty();
    }

    @Test
    void a_reflect_noSetAccessibleAddOpensOrPreview() {
        check(PortalRules.reflect());
        assertThat(buildFileViolations("A-REFLECT")).isEmpty();
    }

    @Test
    void a_optionalSlot_optionalIsOnlyAReturnType() {
        check(PortalRules.optionalSlot());
    }

    @Test
    void a_optionalGet_noOptionalGet() {
        check(PortalRules.optionalGet());
    }

    @Test
    void a_charset_noDefaultCharset() {
        check(PortalRules.charset());
    }

    @Test
    void a_sleep_noThreadSleep() {
        check(PortalRules.sleep());
    }

    private void check(List<ArchRule> rules) {
        // A module whose package holds only package-info has no class yet; that is not a failure of the rule.
        rules.forEach(rule -> rule.allowEmptyShould(true).check(product));
    }

    private List<SourceRules.Violation> sourceViolations(String rule) {
        List<SourceRules.Violation> all = new ArrayList<>();
        modules.forEach(module -> all.addAll(SOURCES.scanSources(root.resolve(module))));
        return all.stream().filter(v -> Objects.equals(rule, v.rule())).toList();
    }

    private List<SourceRules.Violation> buildFileViolations(String rule) {
        List<SourceRules.Violation> all = new ArrayList<>(SOURCES.scanBuildFile(root.resolve("build.gradle.kts"), null));
        modules.forEach(module -> all.addAll(SOURCES.scanBuildFile(root.resolve(module).resolve("build.gradle.kts"), module.substring("portal-".length()))));
        return all.stream().filter(v -> Objects.equals(rule, v.rule())).toList();
    }
}
