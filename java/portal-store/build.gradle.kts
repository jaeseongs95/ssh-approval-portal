// Storage adapter: Spring Data JDBC entities and repositories, the ANSI migration scripts. The DataSource, pool and transaction manager come from Boot's
// auto-configuration and spring.datasource.* (Principles 4.1); the embedded H2 is the default database and a user's JDBC driver replaces it by configuration.
// The schema is migrated by Flyway (db/migration/V{n}__*.sql, its own history table): Boot's migration guide names it, so no history table or script runner is
// written by hand (docs/migration/official-docs-spring.md, row A and Q5-3).
dependencies {
    api(project(":portal-app"))
    api("org.springframework.boot:spring-boot-starter-data-jdbc")
    api("org.springframework.boot:spring-boot-starter-flyway")
    runtimeOnly("com.h2database:h2")
}
