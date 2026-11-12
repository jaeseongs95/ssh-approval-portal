pluginManagement {
    // The one place that states the Spring Boot version (gradle.properties: springBootVersion); build.gradle.kts reads the same property for the BOM.
    // gradle.properties values are extra properties of the settings object ('val x: T by settings' is deprecated since Gradle 9.6, removal in 10).
    val springBootVersion = settings.extra["springBootVersion"] as String
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
