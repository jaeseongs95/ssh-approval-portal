// Storage adapter: Spring Data JDBC entities and repositories, the ANSI migration scripts. The DataSource, pool and transaction manager come from Boot's
// auto-configuration and spring.datasource.* (Principles 4.1); the embedded H2 is the default database and a user's JDBC driver replaces it by configuration.
// The schema is migrated by Flyway (its own history table): Boot's migration guide names it, so no history table or script runner is written by hand
// (docs/migration/official-docs-spring.md, row A and Q5-3). The scripts are common to H2, PostgreSQL, MariaDB and MySQL (db/migration/common); the long-text
// columns have no common type and come from db/migration/{vendor}, which spring.flyway.locations selects with the {vendor} placeholder
// (https://docs.spring.io/spring-boot/how-to/data-initialization.html, "Execute Flyway Database Migrations on Startup"):
//   spring.flyway.locations=classpath:db/migration/common,classpath:db/migration/{vendor}
// No JDBC driver other than H2 is a dependency of the product here (the PostgreSQL driver is test-only, for externalDbmsTest below); which drivers ship, and the Flyway
// modules of the other databases (flyway-database-postgresql, flyway-mysql), are decided where the product is assembled (portal-server).
dependencies {
    api(project(":portal-app"))
    api("org.springframework.boot:spring-boot-starter-data-jdbc")
    api("org.springframework.boot:spring-boot-starter-flyway")
    runtimeOnly("com.h2database:h2")

    // @DataJdbcTest lives in the test module spring-boot-data-jdbc-test, package org.springframework.boot.data.jdbc.test.autoconfigure
    // (https://docs.spring.io/spring-boot/appendix/test-auto-configuration/slices.html, https://docs.spring.io/spring-boot/reference/testing/test-modules.html);
    // the starter brings spring-boot-test (ApplicationContextRunner) and the other test libraries (https://docs.spring.io/spring-boot/reference/testing/test-scope-dependencies.html).
    testImplementation("org.springframework.boot:spring-boot-data-jdbc-test")
    testImplementation("org.springframework.boot:spring-boot-starter-test")

    // The test code has a LauncherSessionListener (ExternalDbmsSchemaSession), so the launcher API is on the compile class path; the version is the BOM's (JUnit).
    testImplementation("org.junit.platform:junit-platform-launcher")

    // For the task externalDbmsTest only in effect: the tests run on the embedded H2 database unless that task points them at PostgreSQL. The versions are Spring Boot's BOM
    // (postgresql 42.7.14, flyway 12.4.0 for Spring Boot 4.1.2). Neither is a product dependency; which drivers ship is decided where the product is assembled (portal-server).
    testRuntimeOnly("org.postgresql:postgresql")
    testRuntimeOnly("org.flywaydb:flyway-database-postgresql")
}

// ---- externalDbmsTest: the storage tests on the PostgreSQL of this PC and of CI (stage 2 design 13.3a) ----
// Not part of check or build: a person or the CI job of stage 8 calls it by name. It runs the same test classes as :portal-store:test (the test source set), one fork.
// The connection is three Gradle properties (this PC: the gradle.properties of the dedicated GRADLE_USER_HOME; CI: -P or ORG_GRADLE_PROJECT_*):
//   portal.test.dbms.postgresql.url            the JDBC URL of the database
//   portal.test.dbms.postgresql.user           the account
//   portal.test.dbms.postgresql.password-file  the PATH of a file that holds the password
// This script never reads the password file, so the password is no input of the task, no cache key and no line of the build output: the path goes to the test JVM as a system
// property and ExternalDbmsEnvironment (test source set) reads the file there. A missing property fails the task with a message; the task never skips and never falls back
// to H2. The tests use the one schema portal_store_it of that database (ExternalDbmsSchemaSession makes it empty before the run and drops it after it).
val postgresqlUrl = providers.gradleProperty("portal.test.dbms.postgresql.url")
val postgresqlUser = providers.gradleProperty("portal.test.dbms.postgresql.user")
val postgresqlPasswordFile = providers.gradleProperty("portal.test.dbms.postgresql.password-file")

tasks.register<Test>("externalDbmsTest") {
    description = "Runs the storage tests on PostgreSQL (Gradle properties portal.test.dbms.postgresql.url, .user and .password-file); not part of check."
    group = "verification"
    testClassesDirs = sourceSets["test"].output.classesDirs
    classpath = sourceSets["test"].runtimeClasspath
    maxParallelForks = 1 // the account allows 10 connections and the tests share one schema
    // A run against a live server is never up to date and never taken from a cache (Task.doNotTrackState, https://docs.gradle.org/current/javadoc/org/gradle/api/Task.html).
    doNotTrackState("The result depends on the state of an external database server")

    val forked = this
    doFirst {
        val url = postgresqlUrl.orNull
        val user = postgresqlUser.orNull
        val passwordFile = postgresqlPasswordFile.orNull
        val missing = listOfNotNull(
            "portal.test.dbms.postgresql.url".takeIf { url == null },
            "portal.test.dbms.postgresql.user".takeIf { user == null },
            "portal.test.dbms.postgresql.password-file".takeIf { passwordFile == null },
        )
        if (missing.isNotEmpty()) {
            throw GradleException(
                "externalDbmsTest needs the Gradle properties $missing. Set them in the gradle.properties of the Gradle user home or pass them with -P: the JDBC URL, the account, " +
                    "and the path of a file that holds the password (the build never reads that file; the test JVM does). The task does not fall back to H2.",
            )
        }
        forked.systemProperty("portal.test.dbms.url", url!!)
        forked.systemProperty("portal.test.dbms.user", user!!)
        forked.systemProperty("portal.test.dbms.password-file", passwordFile!!)
        forked.systemProperty("portal.test.dbms.schema", "portal_store_it")
        // One cached Spring context at a time: every context owns a connection pool and the account allows 10 connections
        // (https://docs.spring.io/spring-framework/reference/testing/testcontext-framework/ctx-management/caching.html, property spring.test.context.cache.maxSize).
        forked.systemProperty("spring.test.context.cache.maxSize", "1")
    }
}
