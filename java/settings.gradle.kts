pluginManagement {
    // The one place that states the Spring Boot version (gradle.properties: springBootVersion); build.gradle.kts reads the same property for the BOM.
    val springBootVersion: String by settings
    plugins {
        id("org.springframework.boot") version springBootVersion
    }
}

rootProject.name = "ssh-approval-portal-java"

// Module order is the dependency order (docs/migration/foundation-cases.md, rule A-DIR): domain <- app <- (store, ssh, desktop, web) <- server;
// client needs only domain; migrate needs only store and domain.
include(
    "portal-domain", "portal-app", "portal-store", "portal-ssh", "portal-desktop", "portal-web",
    "portal-server", "portal-client", "portal-migrate", "portal-arch-checks",
)
