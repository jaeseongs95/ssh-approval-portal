package io.github.jaeseongs95.portal.archchecks;

import static org.assertj.core.api.Assertions.assertThat;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.lang.ArchRule;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.List;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.TestInstance.Lifecycle;
import org.junit.jupiter.api.io.TempDir;

/**
 * Each rule must be able to fail: it is run over classes (and files) that break it on purpose and has to name every one of them, and must not name the clean ones.
 * Without this a rule that matches nothing (a wrong owner name, a changed API) would pass the real product vacuously. Cases A-* of docs/migration/foundation-cases.md.
 */
@TestInstance(Lifecycle.PER_CLASS)
class RuleFixturesTest {

    private static final String FIXTURES = "io.github.jaeseongs95.portal.archchecks.fixtures";
    private static final Pattern FIXTURE_CLASS = Pattern.compile("io\\.github\\.jaeseongs95\\.portal\\.archchecks\\.fixtures\\.(?:(?:dir|cycle)\\.\\w+\\.)?(\\w+)");
    private static final ModuleTable FIXTURE_TABLE = new ModuleTable(FIXTURES + ".dir", Map.of("domain", Set.of(), "app", Set.of("domain")));
    private static final ModuleTable PRODUCT_TABLE = ModuleTable.product();
    private static final Set<String> NEVER_FLAGGED = Set.of("Clean", "GoodApp", "PureDomain", "Counter", "GoodAdvice", "GoodController", "Answer", "Order", "GammaUser");
    /** The sub-packages {@code alpha} and {@code beta} of this package depend on each other on purpose; {@code gamma} only uses {@code alpha}. */
    private static final String CYCLE_FIXTURES = FIXTURES + ".cycle";

    // One import for the whole class (PER_CLASS lifecycle): an instance field, not static state.
    private JavaClasses fixtures;

    @BeforeAll
    void importFixtures() {
        fixtures = new ClassFileImporter().importPackages(FIXTURES);
    }

    @Test
    void a_out() {
        assertFlags(PortalRules.out(), "StreamsOut", "StreamsErr");
    }

    @Test
    void a_stack() {
        assertFlags(PortalRules.stack(), "StackPrinter");
    }

    @Test
    void a_value() {
        assertFlags(PortalRules.value(), "ValueOnField", "ValueOnMethod", "ValueOnParameter");
    }

    @Test
    void a_env() {
        assertFlags(PortalRules.env(), "GetsEnv", "GetsProperty", "GetsProperties", "GetsInteger", "GetsBoolean");
    }

    @Test
    void a_json() {
        assertFlags(PortalRules.json(), "NewsJacksonThree", "BuildsJacksonThree", "NewsJacksonTwo");
    }

    @Test
    void a_string() {
        assertFlags(PortalRules.string(), "NewsStringCopy", "InternsString");
    }

    @Test
    void a_jdbc() {
        assertFlags(PortalRules.jdbc(), "NewsJdbcTemplate", "UsesDriverManager");
    }

    @Test
    void a_web() {
        assertThat(flagged(PortalRules.web())).contains("PlainAdvice", "LocalHandlerController", "BytesBodyController", "MapResponseController")
            .doesNotContain("GoodAdvice", "GoodController");
    }

    @Test
    void a_util() {
        assertFlags(PortalRules.util(), "StaticOnlyHelper");
    }

    @Test
    void a_util_theAllowListLetsAListedClassThrough() {
        assertThat(flagged(PortalRules.util(Set.of(FIXTURES + ".StaticOnlyHelper")))).doesNotContain("StaticOnlyHelper");
    }

    @Test
    void a_dip() {
        assertFlags(PortalRules.dependencyInjection(), "GetsBean");
    }

    @Test
    void a_encap() {
        assertFlags(PortalRules.encapsulation(), "PublicMutableField");
    }

    @Test
    void a_lsp() {
        assertFlags(PortalRules.unsupported(), "ReadOnlyStore");
    }

    @Test
    void a_time() {
        assertFlags(PortalRules.time(), "NowInstant", "NowLocalDate", "NowInZone", "SystemZone", "UsesDate", "UsesCalendar");
    }

    @Test
    void a_os() {
        assertFlags(PortalRules.os(), "ReadsFileSeparator");
    }

    @Test
    void a_thread() {
        assertFlags(PortalRules.thread(), "NewsThread", "ExtendsThread", "VirtualThreads", "UsesExecutors", "NewsPool", "NewsTimer");
    }

    @Test
    void a_process() {
        assertFlags(PortalRules.process(Set.of()), "StartsProcess", "ExecsRuntime");
        assertThat(flagged(PortalRules.process(Set.of(FIXTURES + ".StartsProcess"))))
            .as("a class on the allow list may start a process, the others may not").doesNotContain("StartsProcess").contains("ExecsRuntime");
    }

    @Test
    void a_dir() {
        assertFlags(PortalRules.direction(FIXTURE_TABLE), "BadDomain");
    }

    @Test
    void a_domain() {
        assertFlags(PortalRules.domain(FIXTURE_TABLE), "BadDomain", "SpringInDomain");
    }

    @Test
    void a_cycle() {
        // alpha uses beta and beta uses alpha: both classes are named; gamma uses alpha only, so it is on no cycle and is not named.
        assertFlagsAndSparesCleanClasses(PortalRules.cycles(List.of(CYCLE_FIXTURES)), "AlphaPart", "BetaPart");
    }

    @Test
    void a_lombok() {
        assertFlags(PortalRules.lombok(), "UsesLombok");
    }

    @Test
    void a_reflect() {
        assertFlags(PortalRules.reflect(), "SetsAccessible");
    }

    @Test
    void a_optionalSlot() {
        assertFlagsAndSparesCleanClasses(PortalRules.optionalSlot(), "OptionalField", "OptionalParameter", "OptionalComponent");
    }

    @Test
    void a_optionalGet() {
        assertFlagsAndSparesCleanClasses(PortalRules.optionalGet(), "GetsOptional");
    }

    @Test
    void a_charset() {
        assertFlagsAndSparesCleanClasses(PortalRules.charset(), "GetsBytesWithDefaultCharset", "NewsStringFromBytes", "NewsStringFromByteRange",
            "NewsInputStreamReader", "NewsOutputStreamWriter");
    }

    @Test
    void a_sleep() {
        assertFlagsAndSparesCleanClasses(PortalRules.sleep(), "SleepsMillis", "SleepsDuration");
    }

    @Test
    void cleanClassesAreNeverFlaggedByAnyRule() {
        List<ArchRule> all = new java.util.ArrayList<>();
        all.addAll(PortalRules.out());
        all.addAll(PortalRules.stack());
        all.addAll(PortalRules.value());
        all.addAll(PortalRules.env());
        all.addAll(PortalRules.json());
        all.addAll(PortalRules.string());
        all.addAll(PortalRules.jdbc());
        all.addAll(PortalRules.web());
        all.addAll(PortalRules.util());
        all.addAll(PortalRules.encapsulation());
        all.addAll(PortalRules.unsupported());
        all.addAll(PortalRules.dependencyInjection());
        all.addAll(PortalRules.time());
        all.addAll(PortalRules.os());
        all.addAll(PortalRules.thread());
        all.addAll(PortalRules.process(Set.of()));
        all.addAll(PortalRules.direction(FIXTURE_TABLE));
        all.addAll(PortalRules.domain(FIXTURE_TABLE));
        all.addAll(PortalRules.lombok());
        all.addAll(PortalRules.reflect());
        all.addAll(PortalRules.optionalSlot());
        all.addAll(PortalRules.optionalGet());
        all.addAll(PortalRules.charset());
        all.addAll(PortalRules.sleep());
        all.addAll(PortalRules.cycles(List.of(CYCLE_FIXTURES)));
        assertThat(flagged(all)).doesNotContainAnyElementsOf(NEVER_FLAGGED);
    }

    @Test
    void moduleTableForbidsTheDirectionsTheDesignForbids(@TempDir Path directory) throws IOException {
        // The product table: nothing uses server; client needs domain only; migrate needs store and domain only; siblings do not use each other.
        assertThat(PRODUCT_TABLE.mayUse().get("client")).containsExactly("domain");
        assertThat(PRODUCT_TABLE.mayUse().get("migrate")).containsExactlyInAnyOrder("store", "domain");
        assertThat(PRODUCT_TABLE.mayUse().values()).noneMatch(allowed -> allowed.contains("server"));
        assertThat(PRODUCT_TABLE.mayUse().get("web")).doesNotContain("store", "ssh", "desktop");
        // Build files: a project dependency in the wrong direction, Lombok, add-opens and enable-preview are found; the allowed direction is not.
        Path wrong = directory.resolve("wrong.gradle.kts");
        Files.writeString(wrong, "dependencies { api(project(\":portal-app\")) ; compileOnly(\"org.projectlombok:lombok\") }\ntasks { jvmArgs(\"--add-opens=a/b=ALL-UNNAMED\", \"--enable-preview\") }\n");
        SourceRules sources = new SourceRules(PRODUCT_TABLE);
        assertThat(sources.scanBuildFile(wrong, "domain")).extracting(SourceRules.Violation::rule)
            .containsExactlyInAnyOrder("A-DIR", "A-LOMBOK", "A-REFLECT", "A-REFLECT");
        Path right = directory.resolve("right.gradle.kts");
        Files.writeString(right, "dependencies { api(project(\":portal-domain\")) }\n");
        assertThat(sources.scanBuildFile(right, "app")).isEmpty();
        // Sources: the "os.name" literal and lombok are found; a clean file and an enum value named os (os.name()) are not.
        Path source = directory.resolve("portal-x/src/main/java/p");
        Files.createDirectories(source);
        Files.writeString(source.resolve("Os.java"), "package p;\nclass Os { String n = \"os.name\"; }\n");
        Files.writeString(source.resolve("L.java"), "package p;\nimport lombok.Getter;\nclass L { }\n");
        Files.writeString(source.resolve("Ok.java"), "package p;\nclass Ok { }\n");
        Files.writeString(source.resolve("Target.java"), "package p;\nclass Target { enum TargetOs { LINUX } TargetOs os; String n() { return os.name(); } }\n");
        assertThat(sources.scanSources(directory.resolve("portal-x"))).extracting(SourceRules.Violation::rule).containsExactlyInAnyOrder("A-OS", "A-LOMBOK");
    }

    private void assertFlags(List<ArchRule> rules, String... expected) {
        assertThat(flagged(rules)).contains(expected);
    }

    /** The violating fixtures are named in the failure report; the clean ones (Clean holds the allowed form of every rule) are not. */
    private void assertFlagsAndSparesCleanClasses(List<ArchRule> rules, String... expected) {
        assertThat(flagged(rules)).contains(expected).doesNotContainAnyElementsOf(NEVER_FLAGGED);
    }

    private Set<String> flagged(List<ArchRule> rules) {
        Set<String> names = new TreeSet<>();
        for (ArchRule rule : rules) {
            for (String detail : rule.evaluate(fixtures).getFailureReport().getDetails()) {
                Matcher matcher = FIXTURE_CLASS.matcher(detail);
                while (matcher.find()) {
                    names.add(matcher.group(1));
                }
            }
        }
        return names;
    }

    private Set<String> flagged(ArchRule rule) {
        return flagged(List.of(rule));
    }
}
