// Storage adapter: Spring Data JDBC entities and repositories, the ANSI migration scripts. The DataSource, pool and transaction manager come from Boot's
// auto-configuration and spring.datasource.* (Principles 4.1); the embedded H2 is the default database and a user's JDBC driver replaces it by configuration.
// The schema is migrated by Flyway (its own history table): Boot's migration guide names it, so no history table or script runner is written by hand
// (docs/migration/official-docs-spring.md, row A and Q5-3). The scripts are common to H2, PostgreSQL, MariaDB and MySQL (db/migration/common); the long-text
// columns have no common type and come from db/migration/{vendor}, which spring.flyway.locations selects with the {vendor} placeholder
// (https://docs.spring.io/spring-boot/how-to/data-initialization.html, "Execute Flyway Database Migrations on Startup"):
//   spring.flyway.locations=classpath:db/migration/common,classpath:db/migration/{vendor}
// No JDBC driver other than H2 is a dependency here; which drivers ship, and the Flyway modules of the other databases (flyway-database-postgresql, flyway-mysql),
// are decided where the product is assembled (portal-server).
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
}
