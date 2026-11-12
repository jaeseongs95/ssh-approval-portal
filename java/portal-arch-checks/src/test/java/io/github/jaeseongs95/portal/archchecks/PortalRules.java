package io.github.jaeseongs95.portal.archchecks;

import com.tngtech.archunit.base.DescribedPredicate;
import com.tngtech.archunit.core.domain.JavaCall;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.domain.JavaCodeUnit;
import com.tngtech.archunit.core.domain.JavaFieldAccess;
import com.tngtech.archunit.core.domain.JavaMethod;
import com.tngtech.archunit.core.domain.JavaModifier;
import com.tngtech.archunit.core.domain.JavaParameter;
import com.tngtech.archunit.lang.ArchCondition;
import com.tngtech.archunit.lang.ArchRule;
import com.tngtech.archunit.lang.ConditionEvents;
import com.tngtech.archunit.lang.SimpleConditionEvent;
import com.tngtech.archunit.lang.syntax.ArchRuleDefinition;
import com.tngtech.archunit.library.GeneralCodingRules;
import com.tngtech.archunit.library.dependencies.SlicesRuleDefinition;
import java.lang.reflect.AccessibleObject;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.GregorianCalendar;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.function.Predicate;

/**
 * The bytecode rules. Each rule names the section of "Java·Spring 개발원칙" it enforces (Principles X.Y) and the case id of docs/migration/foundation-cases.md.
 * A rule that finds nothing proves nothing, so RuleFixturesTest runs every rule over classes that break it on purpose.
 */
final class PortalRules {

    /** Classes that may start an operating system process. Empty for now; the portal-desktop classes that start xfreerdp3 and Xvnc are added later (no Java replacement). */
    static final Set<String> PROCESS_ALLOWED = Set.of();

    /** Static-only classes that may exist: a constant holder or a pure value calculation, each with its reason. Empty: nothing in the skeleton qualifies yet. */
    static final Set<String> UTILITY_ALLOWED = Set.of();

    private static final String VALUE = "org.springframework.beans.factory.annotation.Value";
    private static final Set<String> JSON_MAPPER_TYPES = Set.of("com.fasterxml.jackson.databind.ObjectMapper", "com.fasterxml.jackson.databind.json.JsonMapper",
        "tools.jackson.databind.ObjectMapper", "tools.jackson.databind.json.JsonMapper");
    private static final Set<String> NOW_OWNERS = Set.of("java.time.Instant", "java.time.LocalDate", "java.time.LocalDateTime", "java.time.LocalTime",
        "java.time.ZonedDateTime", "java.time.OffsetDateTime", "java.time.OffsetTime", "java.time.Year", "java.time.YearMonth", "java.time.MonthDay");
    private static final Set<String> FILE_SEPARATOR_FIELDS = Set.of("separator", "separatorChar", "pathSeparator", "pathSeparatorChar");
    private static final Set<String> THREAD_FACTORIES = Set.of("ofVirtual", "ofPlatform", "startVirtualThread");
    private static final Set<String> POOL_TYPES = Set.of("java.util.concurrent.ThreadPoolExecutor", "java.util.concurrent.ScheduledThreadPoolExecutor",
        "java.util.concurrent.ForkJoinPool", "java.util.Timer");
    /** A parameter of one of these types states the character set (a name or an object), so the constructor or method does not fall back to the default. */
    private static final Set<String> CHARSET_PARAMETER_TYPES = Set.of("java.lang.String", "java.nio.charset.Charset", "java.nio.charset.CharsetDecoder",
        "java.nio.charset.CharsetEncoder");

    /** The Spring Framework 7 resilience and retry types A-NO-RETRY-EXEC keeps out of the exec code (the older spring-retry package is matched by prefix). */
    private static final Set<String> RETRY_TYPES = Set.of("org.springframework.resilience.annotation.Retryable", "org.springframework.resilience.annotation.ConcurrencyLimit",
        "org.springframework.resilience.annotation.EnableResilientMethods", "org.springframework.core.retry.RetryTemplate", "org.springframework.core.retry.RetryPolicy");
    /** The enum methods through which bytecode compares, orders or enumerates a TargetOs value. */
    private static final Set<String> OS_BRANCH_METHODS = Set.of("ordinal", "values", "valueOf", "equals", "compareTo");

    private PortalRules() {
    }

    /** A-OUT, Principles 6: logging goes through SLF4J, never the standard streams. */
    static List<ArchRule> out() {
        return List.of(GeneralCodingRules.NO_CLASSES_SHOULD_ACCESS_STANDARD_STREAMS.as("A-OUT: no class accesses System.out or System.err (Principles 6)"));
    }

    /** A-STACK, Principles 6: an exception goes to the logger as the last argument. */
    static List<ArchRule> stack() {
        return List.of(ArchRuleDefinition.noClasses()
            .should().callCodeUnitWhere(call("calls printStackTrace on a Throwable",
                c -> "printStackTrace".equals(c.getTarget().getName()) && c.getTargetOwner().isAssignableTo(Throwable.class)))
            .as("A-STACK: no class calls Throwable.printStackTrace (Principles 6)"));
    }

    /** A-VALUE, Principles 3.5 and 2.2 category 7: configuration is a @ConfigurationProperties record. Fields, methods and constructor parameters. */
    static List<ArchRule> value() {
        ArchCondition<JavaCodeUnit> parameterWithValue = new ArchCondition<>("have a parameter annotated with @Value") {
            @Override
            public void check(JavaCodeUnit unit, ConditionEvents events) {
                for (JavaParameter parameter : unit.getParameters()) {
                    if (parameter.isAnnotatedWith(VALUE)) {
                        events.add(SimpleConditionEvent.violated(unit, unit.getFullName() + " has a parameter annotated with @Value"));
                    }
                }
            }
        };
        return List.of(
            ArchRuleDefinition.noFields().should().beAnnotatedWith(VALUE).as("A-VALUE: no field is annotated with @Value (Principles 3.5)"),
            ArchRuleDefinition.noMethods().should().beAnnotatedWith(VALUE).as("A-VALUE: no method is annotated with @Value (Principles 3.5)"),
            ArchRuleDefinition.codeUnits().should(parameterWithValue).as("A-VALUE: no method or constructor parameter is annotated with @Value (Principles 3.5)"));
    }

    /** A-ENV, Principles 3.5: environment and system properties are read by Boot's Binder, not by the code. This also covers {@code System.getProperty("os.name")}. */
    static List<ArchRule> env() {
        return List.of(ArchRuleDefinition.noClasses()
            .should().callCodeUnitWhere(call("reads the environment or a system property", c -> {
                String owner = c.getTargetOwner().getName(), name = c.getTarget().getName();
                return "java.lang.System".equals(owner) && Set.of("getenv", "getProperty", "getProperties").contains(name)
                    || "java.lang.Integer".equals(owner) && "getInteger".equals(name)
                    || "java.lang.Long".equals(owner) && "getLong".equals(name)
                    || "java.lang.Boolean".equals(owner) && "getBoolean".equals(name);
            }))
            .as("A-ENV: no class calls System.getenv or System.getProperty (Principles 3.5)"));
    }

    /** A-JSON, Principles 2.2 category 2: one Boot JsonMapper bean (JsonMapperBuilderCustomizer for settings); no exception, not even a configuration class. */
    static List<ArchRule> json() {
        return List.of(ArchRuleDefinition.noClasses()
            .should().callCodeUnitWhere(call("builds a JSON mapper", c -> JSON_MAPPER_TYPES.contains(c.getTargetOwner().getName())
                && ("<init>".equals(c.getTarget().getName()) || "builder".equals(c.getTarget().getName()))))
            .as("A-JSON: no class does new ObjectMapper / new JsonMapper / JsonMapper.builder() (Principles 2.2 category 2)"));
    }

    /** A-TIME, Principles 4.5: the injected Clock is the one source of time; no system default zone, no Date, no Calendar. */
    static List<ArchRule> time() {
        return List.of(
            ArchRuleDefinition.noClasses()
                .should().callCodeUnitWhere(call("reads the wall clock without a Clock", c -> {
                    String owner = c.getTargetOwner().getName(), name = c.getTarget().getName();
                    List<JavaClass> parameters = c.getTarget().getRawParameterTypes();
                    boolean clockParameter = parameters.size() == 1 && "java.time.Clock".equals(parameters.get(0).getName());
                    return NOW_OWNERS.contains(owner) && "now".equals(name) && !clockParameter
                        || "java.time.ZoneId".equals(owner) && "systemDefault".equals(name)
                        || "java.time.Clock".equals(owner) && "systemDefaultZone".equals(name)
                        || "java.util.TimeZone".equals(owner) && "getDefault".equals(name);
                }))
                .as("A-TIME: no now() without a Clock, no ZoneId.systemDefault, Clock.systemDefaultZone or TimeZone.getDefault (Principles 4.5)"),
            ArchRuleDefinition.noClasses()
                .should().dependOnClassesThat(JavaClass.Predicates.belongToAnyOf(Date.class, Calendar.class, GregorianCalendar.class))
                .as("A-TIME: no class uses java.util.Date or Calendar (Principles 4.5)"));
    }

    /** A-OS (bytecode half), Principles 1.1 and 1.2: no operating system judgement through File separators. The "os.name" literal is checked in the sources (SourceRules). */
    static List<ArchRule> os() {
        return List.of(ArchRuleDefinition.noClasses()
            .should().accessFieldWhere(DescribedPredicate.<JavaFieldAccess>describe("access a java.io.File separator field",
                a -> "java.io.File".equals(a.getTarget().getOwner().getName()) && FILE_SEPARATOR_FIELDS.contains(a.getTarget().getName())))
            .as("A-OS: no class reads File.separator or File.pathSeparator (Principles 1.1, 1.2)"));
    }

    /** A-THREAD, Principles 2.2 category 8: threads come from the Spring TaskExecutor and the scheduler. */
    static List<ArchRule> thread() {
        return List.of(
            ArchRuleDefinition.noClasses().should().beAssignableTo(Thread.class).as("A-THREAD: no class is a Thread (Principles 2.2 category 8)"),
            ArchRuleDefinition.noClasses()
                .should().callCodeUnitWhere(call("creates a thread or a pool", c -> {
                    String owner = c.getTargetOwner().getName(), name = c.getTarget().getName();
                    return "java.lang.Thread".equals(owner) && ("<init>".equals(name) || THREAD_FACTORIES.contains(name))
                        || "java.util.concurrent.Executors".equals(owner)
                        || POOL_TYPES.contains(owner) && "<init>".equals(name);
                }))
                .as("A-THREAD: no class creates a Thread, uses Executors or builds a pool or Timer (Principles 2.2 category 8)"));
    }

    /** A-PROCESS, Principles 1.4 and 2.2 category 6: starting an OS process is allowed only in the listed classes. */
    static List<ArchRule> process(Set<String> allowedClasses) {
        return List.of(ArchRuleDefinition.noClasses().that(notIn(allowedClasses))
            .should().callCodeUnitWhere(call("starts an operating system process", PortalRules::startsProcess))
            .as("A-PROCESS: only the listed classes use ProcessBuilder or Runtime.exec (Principles 1.4, 2.2 category 6)"));
    }

    private static boolean startsProcess(JavaCall<?> call) {
        String owner = call.getTargetOwner().getName();
        return "java.lang.ProcessBuilder".equals(owner) || "java.lang.Runtime".equals(owner) && "exec".equals(call.getTarget().getName());
    }

    /**
     * A-MINA (S3-AB-02), stage 3 design 2.1: the vendor boundary. Only the classes of portal-ssh (the {@code ssh} package of the table) may use {@code org.apache.sshd};
     * app, domain, store and every other module see the ports, never the SSH library (Principles 3.2, vendor independence).
     */
    static List<ArchRule> mina(ModuleTable table) {
        return List.of(ArchRuleDefinition.noClasses().that().resideOutsideOfPackage(table.packageOf("ssh") + "..")
            .should().dependOnClassesThat().resideInAnyPackage("org.apache.sshd..")
            .as("A-MINA: only portal-ssh uses org.apache.sshd (stage 3 design 2.1; Principles 3.2)"));
    }

    /**
     * A-NO-LOCAL-PROCESS (S3-AB-03): a remote command is an SSH channel, never a local process. A-PROCESS has an allow list; this rule keeps every class of portal-ssh
     * off that list for good, whatever the list holds (the portal-desktop classes that start xfreerdp3 and Xvnc are the only reason the list exists).
     */
    static List<ArchRule> noLocalProcess(ModuleTable table) {
        return List.of(ArchRuleDefinition.noClasses().that().resideInAPackage(table.packageOf("ssh") + "..")
            .should().callCodeUnitWhere(call("starts an operating system process", PortalRules::startsProcess))
            .as("A-NO-LOCAL-PROCESS: no class of portal-ssh uses ProcessBuilder or Runtime.exec (stage 3 design 2.1)"));
    }

    /**
     * A-NO-RETRY-EXEC (S3-AB-04): an exec or upload request is never sent again by the framework. The {@code ssh.exec} package and every implementation of
     * {@code app.remote.RemoteExecutor} stay free of {@code @Retryable}, {@code RetryTemplate}, {@code @ConcurrencyLimit} and the older spring-retry types.
     * A hand-written retry loop is not visible in bytecode; it is a review item and the S3-EX no-resend cases fix the behaviour.
     */
    static List<ArchRule> noRetryExec(ModuleTable table) {
        DescribedPredicate<JavaClass> execClasses = JavaClass.Predicates.resideInAPackage(table.packageOf("ssh") + ".exec..")
            .or(JavaClass.Predicates.assignableTo(table.packageOf("app") + ".remote.RemoteExecutor"));
        DescribedPredicate<JavaClass> retryTypes = DescribedPredicate.describe("are retry or concurrency-limit types",
            type -> RETRY_TYPES.contains(type.getName()) || type.getName().startsWith("org.springframework.retry."));
        return List.of(ArchRuleDefinition.noClasses().that(execClasses).should().dependOnClassesThat(retryTypes)
            .as("A-NO-RETRY-EXEC: ssh.exec and the RemoteExecutor implementations use no @Retryable, RetryTemplate or @ConcurrencyLimit (stage 3 design 2.1; Principles 3.6)"));
    }

    /**
     * A-SSH-NO-PLATFORM-BRANCH (S3-AB-09), pattern 8.12: the target OS is chosen by the {@code List<TargetPlatform>} the registry collects, not by a branch in the shared
     * code. In the classes of portal-ssh the bytecode of a branch on {@code TargetOs} shows as {@code ordinal()}, {@code values()}, {@code valueOf}, {@code equals},
     * {@code compareTo}, a {@code $SwitchMap$...TargetOs} read (the old-style switch), or a read of one of its constants outside a {@code TargetPlatform}
     * implementation (the {@code ==} comparison). A {@code TargetPlatform} may name its own constant ({@code return TargetOs.WINDOWS}). The registry sits in portal-app.
     * Not visible: a pattern switch (invokedynamic) and an {@code ==} inside a {@code TargetPlatform}; those are review items.
     */
    static List<ArchRule> noPlatformBranch(ModuleTable table) {
        String ssh = table.packageOf("ssh") + "..";
        String targetOs = table.packageOf("domain") + ".target.TargetOs";
        String targetPlatform = table.packageOf("app") + ".target.TargetPlatform";
        String switchMap = "$SwitchMap$" + targetOs.replace('.', '$');
        return List.of(
            ArchRuleDefinition.noClasses().that().resideInAPackage(ssh)
                .should().callCodeUnitWhere(call("branches on or enumerates the target OS",
                    c -> targetOs.equals(c.getTargetOwner().getName()) && OS_BRANCH_METHODS.contains(c.getTarget().getName())))
                .as("A-SSH-NO-PLATFORM-BRANCH: no class of portal-ssh calls ordinal, values, valueOf, equals or compareTo on TargetOs (pattern 8.12)"),
            ArchRuleDefinition.noClasses().that().resideInAPackage(ssh)
                .should().accessFieldWhere(DescribedPredicate.<JavaFieldAccess>describe("read the switch map of the target OS", a -> switchMap.equals(a.getTarget().getName())))
                .as("A-SSH-NO-PLATFORM-BRANCH: no class of portal-ssh switches on TargetOs (pattern 8.12)"),
            ArchRuleDefinition.noClasses().that().resideInAPackage(ssh).and().areNotAssignableTo(targetPlatform)
                .should().accessFieldWhere(DescribedPredicate.<JavaFieldAccess>describe("read a TargetOs constant",
                    a -> targetOs.equals(a.getTarget().getOwner().getName())))
                .as("A-SSH-NO-PLATFORM-BRANCH: only a TargetPlatform implementation of portal-ssh reads a TargetOs constant (pattern 8.12)"));
    }

    /**
     * A-REMOTE-RESULT (S3-AB-06), Principles 35: the methods of the ports (the interfaces of {@code app.remote}) do not answer with {@code Optional}, {@code boolean} or
     * {@code Boolean}, which fold "none", "unsupported" and "unknown" into one value, and an own result type that is an interface must be {@code sealed}. The result
     * types of the design are sealed interfaces or records ({@code ExecutionReport}). The one flag query is {@code CancelToken.requested()}: it reports a request
     * that was made, not an outcome of the remote side.
     */
    static List<ArchRule> remoteResult(ModuleTable table) {
        String remote = table.packageOf("app") + ".remote";
        String flagQuery = remote + ".CancelToken";
        ArchCondition<JavaMethod> sealedResult = new ArchCondition<>("answer with a sealed result, a record or void, not Optional or boolean") {
            @Override
            public void check(JavaMethod method, ConditionEvents events) {
                if (flagQuery.equals(method.getOwner().getName())) {
                    return;
                }
                JavaClass type = method.getRawReturnType();
                boolean folded = type.isEquivalentTo(Optional.class) || type.isEquivalentTo(boolean.class) || type.isEquivalentTo(Boolean.class);
                boolean ownLooseInterface = type.isInterface() && !type.isSealed()
                    && (type.getPackageName().equals(remote) || type.getPackageName().startsWith(remote + "."));
                if (folded || ownLooseInterface) {
                    events.add(SimpleConditionEvent.violated(method, method.getFullName() + " answers with " + type.getName()
                        + (folded ? ", which folds none, unsupported and unknown into one value" : ", an interface that is not sealed")));
                }
            }
        };
        return List.of(ArchRuleDefinition.methods().that().areDeclaredInClassesThat().resideInAPackage(remote + "..")
            .and().areDeclaredInClassesThat().areInterfaces()
            .should(sealedResult)
            .as("A-REMOTE-RESULT: a port of app.remote answers with a sealed result or a record, not Optional or boolean (stage 3 design 2.1; Principles 35)"));
    }

    /**
     * A-AUDIT-BOUNDARY (S3-AB-10), decision D3-14 (b): {@code AuditFailedException} is an infrastructure exception; the use case turns it into
     * {@code DispatchRefusedException(AUDIT_FAILED)} at its boundary. A public method of {@code app.execution} or {@code app.file} therefore does not declare it in
     * {@code throws}. The exception is unchecked, so an undeclared leak is not visible in bytecode; the S3-UC cases fix the conversion at run time.
     */
    static List<ArchRule> auditBoundary(ModuleTable table) {
        String app = table.packageOf("app");
        String auditFailed = app + ".audit.AuditFailedException";
        ArchCondition<JavaMethod> noAuditThrows = new ArchCondition<>("not declare AuditFailedException") {
            @Override
            public void check(JavaMethod method, ConditionEvents events) {
                if (method.getThrowsClause().containsType(auditFailed)) {
                    events.add(SimpleConditionEvent.violated(method, method.getFullName() + " declares AuditFailedException in its throws clause"));
                }
            }
        };
        return List.of(ArchRuleDefinition.methods().that().arePublic()
            .and().areDeclaredInClassesThat().resideInAnyPackage(app + ".execution..", app + ".file..")
            .should(noAuditThrows)
            .as("A-AUDIT-BOUNDARY: a public method of app.execution or app.file does not let AuditFailedException out (decision D3-14)"));
    }

    /** A-DIR, Principles 3.2: a module's classes depend only on the modules the table allows. */
    static List<ArchRule> direction(ModuleTable table) {
        List<ArchRule> rules = new ArrayList<>();
        for (String module : table.mayUse().keySet()) {
            for (String other : table.mayUse().keySet()) {
                if (!Objects.equals(other, module) && !table.mayUse().get(module).contains(other)) {
                    rules.add(ArchRuleDefinition.noClasses().that().resideInAPackage(table.packageOf(module) + "..")
                        .should().dependOnClassesThat().resideInAPackage(table.packageOf(other) + "..")
                        .as("A-DIR: " + module + " does not depend on " + other + " (Principles 3.2)"));
                }
            }
        }
        return rules;
    }

    /** A-DOMAIN, Principles 3.2: the domain module needs the JDK and Jackson annotations only. */
    static List<ArchRule> domain(ModuleTable table) {
        String domain = table.packageOf("domain");
        return List.of(ArchRuleDefinition.classes().that().resideInAPackage(domain + "..")
            .should().onlyDependOnClassesThat().resideInAnyPackage("java..", "javax..", "com.fasterxml.jackson.annotation..", domain + "..")
            .allowEmptyShould(true)
            .as("A-DOMAIN: the domain module depends on the JDK, Jackson annotations and itself only (Principles 3.2)"));
    }

    /**
     * A-CYCLE, Principles 3.2: the sub-packages directly below a module's root package form no dependency cycle. A cycle means two packages that cannot be understood,
     * tested or moved one without the other (stage 2 design 13.6, the contract / operation / failure cycles of portal-domain). Classes that sit in the root
     * package itself are not part of any slice. One rule per package root, so the report names the module.
     */
    static List<ArchRule> cycles(List<String> packageRoots) {
        List<ArchRule> rules = new ArrayList<>();
        for (String root : packageRoots) {
            rules.add(SlicesRuleDefinition.slices().matching(root + ".(*)..").should().beFreeOfCycles()
                .as("A-CYCLE: the sub-packages of " + root + " have no dependency cycle (Principles 3.2)"));
        }
        return rules;
    }

    /** A-STRING, Principles 3.3 (check 26): no new String("..."), no hand-made intern. The comparisons themselves ({@code ==}, {@code v.equals("c")}) are a review judgement. */
    static List<ArchRule> string() {
        return List.of(ArchRuleDefinition.noClasses()
            .should().callCodeUnitWhere(call("copies a string or interns it", c -> {
                if (!"java.lang.String".equals(c.getTargetOwner().getName())) {
                    return false;
                }
                List<JavaClass> parameters = c.getTarget().getRawParameterTypes();
                return "intern".equals(c.getTarget().getName())
                    || "<init>".equals(c.getTarget().getName()) && parameters.size() == 1 && "java.lang.String".equals(parameters.get(0).getName());
            }))
            .as("A-STRING: no new String(String) and no String.intern (Principles 3.3)"));
    }

    /** A-JDBC, Principles 4.1: Spring Data JDBC and the Boot DataSource; no JdbcTemplate of our own, no DriverManager. */
    static List<ArchRule> jdbc() {
        return List.of(ArchRuleDefinition.noClasses()
            .should().callCodeUnitWhere(call("builds raw JDBC access", c -> {
                String owner = c.getTargetOwner().getName(), name = c.getTarget().getName();
                return Set.of("org.springframework.jdbc.core.JdbcTemplate", "org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate").contains(owner)
                    && "<init>".equals(name)
                    || "org.springframework.jdbc.core.simple.JdbcClient".equals(owner) && "create".equals(name)
                    || "java.sql.DriverManager".equals(owner);
            }))
            .as("A-JDBC: no new JdbcTemplate, JdbcClient.create or DriverManager (Principles 4.1)"));
    }

    /** A-WEB, Principles 3.8 (checks 27, 28): one advice that extends ResponseEntityExceptionHandler; no local @ExceptionHandler; no raw-bytes body; no Map response. */
    static List<ArchRule> web() {
        String advice = "org.springframework.web.bind.annotation.RestControllerAdvice";
        String controllerAdvice = "org.springframework.web.bind.annotation.ControllerAdvice";
        DescribedPredicate<JavaClass> isAdvice = DescribedPredicate.describe("are controller advice classes",
            c -> c.isAnnotatedWith(advice) || c.isAnnotatedWith(controllerAdvice));
        ArchCondition<JavaCodeUnit> rawBytesBody = new ArchCondition<>("not take a @RequestBody byte[]") {
            @Override
            public void check(JavaCodeUnit unit, ConditionEvents events) {
                for (JavaParameter parameter : unit.getParameters()) {
                    if (parameter.isAnnotatedWith("org.springframework.web.bind.annotation.RequestBody") && parameter.getRawType().isEquivalentTo(byte[].class)) {
                        events.add(SimpleConditionEvent.violated(unit, unit.getFullName() + " takes the request body as byte[]"));
                    }
                }
            }
        };
        ArchCondition<JavaMethod> looseResponse = new ArchCondition<>("not answer with a Map, a JSON tree or byte[]") {
            @Override
            public void check(JavaMethod method, ConditionEvents events) {
                JavaClass type = method.getRawReturnType();
                boolean mapped = method.isMetaAnnotatedWith("org.springframework.web.bind.annotation.RequestMapping")
                    || method.isAnnotatedWith("org.springframework.web.bind.annotation.RequestMapping");
                if (mapped && (type.isAssignableTo(java.util.Map.class) || type.isEquivalentTo(byte[].class)
                    || type.isAssignableTo("tools.jackson.databind.JsonNode") || type.isAssignableTo("com.fasterxml.jackson.databind.JsonNode"))) {
                    events.add(SimpleConditionEvent.violated(method, method.getFullName() + " answers with " + type.getName() + " instead of a record"));
                }
            }
        };
        return List.of(
            ArchRuleDefinition.classes().that(isAdvice).should().beAssignableTo("org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler")
                .allowEmptyShould(true).as("A-WEB: a controller advice extends ResponseEntityExceptionHandler (Principles 3.8)"),
            ArchRuleDefinition.methods().that().areAnnotatedWith("org.springframework.web.bind.annotation.ExceptionHandler")
                .should().beDeclaredInClassesThat(isAdvice).allowEmptyShould(true).as("A-WEB: @ExceptionHandler only in the controller advice (Principles 3.8)"),
            ArchRuleDefinition.codeUnits().should(rawBytesBody).allowEmptyShould(true).as("A-WEB: no @RequestBody byte[] (Principles 3.8)"),
            ArchRuleDefinition.methods().that().areDeclaredInClassesThat().areAnnotatedWith("org.springframework.web.bind.annotation.RestController")
                .should(looseResponse).allowEmptyShould(true).as("A-WEB: a controller answers with a record, not a Map, a JSON tree or byte[] (Principles 3.8)"));
    }

    /**
     * A-UTIL, Principles 3.0 (check 32): a class whose methods are all static is a business helper that judges data-only types from outside. State and its behaviour
     * belong in the same type. The entry point ({@code main}) is not a helper.
     */
    static List<ArchRule> util() {
        return util(UTILITY_ALLOWED);
    }

    /**
     * The same rule with an allow list. Only a constant holder or a pure value calculation (no state, no collaborator, a result that depends on its arguments alone)
     * may be listed, each with its reason next to the class name; the list is empty today.
     */
    static List<ArchRule> util(Set<String> allowedClasses) {
        ArchCondition<JavaClass> notStaticOnly = new ArchCondition<>("not have only static methods") {
            @Override
            public void check(JavaClass javaClass, ConditionEvents events) {
                if (allowedClasses.contains(javaClass.getName())) {
                    return;
                }
                List<JavaMethod> methods = javaClass.getMethods().stream().filter(m -> !m.getModifiers().contains(JavaModifier.SYNTHETIC)).toList();
                boolean helper = !javaClass.isInterface() && !javaClass.isEnum() && !javaClass.isRecord() && !javaClass.isAnnotation()
                    && !methods.isEmpty() && methods.stream().allMatch(m -> m.getModifiers().contains(JavaModifier.STATIC))
                    && methods.stream().anyMatch(m -> !"main".equals(m.getName()));
                if (helper) {
                    events.add(SimpleConditionEvent.violated(javaClass, javaClass.getName() + " has only static methods"));
                }
            }
        };
        return List.of(ArchRuleDefinition.classes().should(notStaticOnly).as("A-UTIL: no class with only static methods (Principles 3.0 encapsulation)"));
    }

    /** A-DIP, Principles 3.0 (check 34): a collaborator arrives through the constructor; no lookup in the container by hand. */
    static List<ArchRule> dependencyInjection() {
        return List.of(ArchRuleDefinition.noClasses()
            .should().callCodeUnitWhere(call("looks a bean up by hand", c -> "getBean".equals(c.getTarget().getName())
                && c.getTargetOwner().isAssignableTo("org.springframework.beans.factory.BeanFactory")))
            .as("A-DIP: no class calls getBean (Principles 3.0 dependency inversion)"));
    }

    /** A-ENCAP, Principles 3.0 (check 32): state is private; a public field is allowed only when it is final. */
    static List<ArchRule> encapsulation() {
        return List.of(ArchRuleDefinition.fields().that().arePublic().should().beFinal().as("A-ENCAP: no public mutable field (Principles 3.0 encapsulation)"));
    }

    /** A-LSP, Principles 3.0 (check 34): what a subtype does not support is a result the contract names, not an UnsupportedOperationException. */
    static List<ArchRule> unsupported() {
        return List.of(ArchRuleDefinition.noClasses()
            .should().callCodeUnitWhere(call("creates an UnsupportedOperationException",
                c -> "java.lang.UnsupportedOperationException".equals(c.getTargetOwner().getName()) && "<init>".equals(c.getTarget().getName())))
            .as("A-LSP: no class throws UnsupportedOperationException (Principles 3.0 substitutability)"));
    }

    /** A-LOMBOK, Principles 8.2. */
    static List<ArchRule> lombok() {
        return List.of(ArchRuleDefinition.noClasses().should().dependOnClassesThat().resideInAnyPackage("lombok..")
            .as("A-LOMBOK: no class depends on Lombok (Principles 8.2)"));
    }

    /** A-REFLECT, Principles 8.2: no setAccessible. */
    static List<ArchRule> reflect() {
        return List.of(ArchRuleDefinition.noClasses()
            .should().callCodeUnitWhere(call("makes a member accessible",
                c -> Set.of("setAccessible", "trySetAccessible").contains(c.getTarget().getName()) && c.getTargetOwner().isAssignableTo(AccessibleObject.class)))
            .as("A-REFLECT: no class calls setAccessible (Principles 8.2)"));
    }

    /**
     * A-OPTIONAL-SLOT, Principles 3.3 and check 35 (anti-patterns O1): Optional is a return type for "no result" and nothing else. A field, a method or constructor
     * parameter and a record component are all excluded; ArchUnit has no record-component model, but the compiler makes every component a private field and a
     * canonical constructor parameter, so the field and parameter rules cover it. Collection elements ({@code List<Optional<T>>}) are not covered.
     */
    static List<ArchRule> optionalSlot() {
        ArchCondition<JavaCodeUnit> optionalParameter = new ArchCondition<>("not have a parameter of type Optional") {
            @Override
            public void check(JavaCodeUnit unit, ConditionEvents events) {
                for (JavaParameter parameter : unit.getParameters()) {
                    if (parameter.getRawType().isEquivalentTo(Optional.class)) {
                        events.add(SimpleConditionEvent.violated(unit, unit.getFullName() + " has a parameter of type Optional"));
                    }
                }
            }
        };
        return List.of(
            ArchRuleDefinition.noFields().should().haveRawType(Optional.class)
                .as("A-OPTIONAL-SLOT: no field or record component has type Optional (Principles 3.3, check 35; anti-patterns O1)"),
            ArchRuleDefinition.codeUnits().should(optionalParameter)
                .as("A-OPTIONAL-SLOT: no method or constructor parameter has type Optional (Principles 3.3, check 35; anti-patterns O1)"));
    }

    /**
     * A-OPTIONAL-GET, Principles 3.3 (anti-patterns O2): JDK API Note of Optional.get(): "The preferred alternative to this method is orElseThrow()." The pairs the
     * bytecode cannot tell apart from legitimate code (isPresent() followed by get(), orElse(null)) are a review item, not a rule.
     */
    static List<ArchRule> optionalGet() {
        return List.of(ArchRuleDefinition.noClasses()
            .should().callCodeUnitWhere(call("calls Optional.get()", c -> "java.util.Optional".equals(c.getTargetOwner().getName())
                && "get".equals(c.getTarget().getName()) && c.getTarget().getRawParameterTypes().isEmpty()))
            .as("A-OPTIONAL-GET: no class calls Optional.get(); use orElseThrow() (Principles 3.3, check 35; JDK Optional.get() API Note; anti-patterns O2)"));
    }

    /**
     * A-CHARSET, anti-patterns Z2 (checklist 15): the default character set depends on the host. Flagged: {@code String.getBytes()} without an argument,
     * {@code new String(byte[]...)} without a charset, and {@code InputStreamReader} / {@code OutputStreamWriter} constructors without a charset. The ones that
     * name a charset (String name, Charset, CharsetDecoder, CharsetEncoder) pass.
     */
    static List<ArchRule> charset() {
        return List.of(ArchRuleDefinition.noClasses()
            .should().callCodeUnitWhere(call("uses the default character set", c -> {
                String owner = c.getTargetOwner().getName(), name = c.getTarget().getName();
                List<JavaClass> parameters = c.getTarget().getRawParameterTypes();
                boolean namesCharset = parameters.stream().anyMatch(type -> CHARSET_PARAMETER_TYPES.contains(type.getName()));
                return "java.lang.String".equals(owner) && "getBytes".equals(name) && parameters.isEmpty()
                    || "java.lang.String".equals(owner) && "<init>".equals(name) && !parameters.isEmpty() && parameters.get(0).isEquivalentTo(byte[].class) && !namesCharset
                    || Set.of("java.io.InputStreamReader", "java.io.OutputStreamWriter").contains(owner) && "<init>".equals(name) && !namesCharset;
            }))
            .as("A-CHARSET: no String.getBytes(), new String(byte[]...), new InputStreamReader or new OutputStreamWriter without a Charset (anti-patterns Z2)"));
    }

    /** A-SLEEP, anti-patterns D3 (checklist 14): wait for the event (onExit, waitFor(timeout), CountDownLatch, Future.get(timeout)), do not poll with Thread.sleep. */
    static List<ArchRule> sleep() {
        return List.of(ArchRuleDefinition.noClasses()
            .should().callCodeUnitWhere(call("calls Thread.sleep", c -> "java.lang.Thread".equals(c.getTargetOwner().getName()) && "sleep".equals(c.getTarget().getName())))
            .as("A-SLEEP: no class calls Thread.sleep (anti-patterns D3)"));
    }

    private static DescribedPredicate<JavaCall<?>> call(String description, Predicate<JavaCall<?>> predicate) {
        return DescribedPredicate.describe(description, predicate);
    }

    private static DescribedPredicate<JavaClass> notIn(Set<String> classNames) {
        return DescribedPredicate.describe("are not in " + classNames, javaClass -> !classNames.contains(javaClass.getName()));
    }
}
