// Use cases: @Service and @Transactional classes, the port interfaces the adapters implement, the Clock / SecureRandom / digest beans, the events published
// after commit, the scheduled work. It knows no MCP, no HTTP, no SSH library and no operating system.
dependencies {
    api(project(":portal-domain"))
    api("org.springframework:spring-context")
    api("org.springframework:spring-tx")
    // The two risk loaders (CommandRiskCatalogLoader, AutomationQuestionLoader) read a JSON resource of portal-domain: the domain may not parse JSON (rule A-DOMAIN),
    // so the module above it does, with the Boot-managed Jackson 3 JsonMapper bean injected (Principles 2.2 categories 1 and 2). Jackson 3 is the
    // tools.jackson.core group; the version is the Boot BOM's.
    api("tools.jackson.core:jackson-databind")

    // ApplicationContextRunner (S2-AP-01, S2-AP-02) is Spring Boot's test class org.springframework.boot.test.context.runner.ApplicationContextRunner;
    // spring-boot-starter-test brings it with spring-boot-test (https://docs.spring.io/spring-boot/reference/testing/test-scope-dependencies.html).
    testImplementation("org.springframework.boot:spring-boot-starter-test")

    // The use cases log through SLF4J like portal-store and portal-ssh (Principles 6); the version is the Boot BOM's. It is not an api dependency: no type of this module
    // exposes a Logger.
    implementation("org.slf4j:slf4j-api")
}
