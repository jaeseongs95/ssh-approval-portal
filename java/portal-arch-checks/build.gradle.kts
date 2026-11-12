// The machine checks of the design rules (docs/migration/foundation-cases.md, cases A-*). Test sources only: nothing depends on this module and it ships
// nothing. It is its own module because the checks read every product module's compiled classes, sources and build files.
// Run one check class alone: ./gradlew :portal-arch-checks:test --tests '*ArchitectureRulesTest'
val productModules = rootProject.subprojects.map { it.name }.filter { it != project.name }.sorted()

dependencies {
    // Bytecode rules. Not in the Spring Boot BOM (spring-boot-dependencies-4.1.2.pom has no com.tngtech entry), so the version is pinned here: 1.5.1 is the
    // newest release on Maven Central (maven-metadata.xml, 2026-11-12) and lists Java 25 class files as supported since 1.4.1 (ArchUnit release notes, 1.4.1).
    testImplementation("com.tngtech.archunit:archunit:1.5.1")
    // The rule fixtures are classes that break a rule on purpose; they need the types the rules name (@Value, the two Jackson generations).
    testImplementation("org.springframework:spring-beans")
    testImplementation("org.springframework:spring-jdbc")
    testImplementation("org.springframework:spring-webmvc")
    testImplementation("jakarta.servlet:jakarta.servlet-api")
    testImplementation("tools.jackson.core:jackson-databind")
    testImplementation("com.fasterxml.jackson.core:jackson-databind")
    testImplementation("org.slf4j:slf4j-api")
}

tasks.named<Test>("test") {
    // Compiled classes of the product modules are read by ArchUnit; sources and build files are read as text.
    productModules.forEach { dependsOn(":$it:classes") }
    inputs.files(fileTree(rootDir) {
        include("portal-*/src/main/**", "portal-*/build.gradle.kts", "build.gradle.kts", "settings.gradle.kts")
        exclude("**/build/**")
    }).withPathSensitivity(PathSensitivity.RELATIVE)
    systemProperty("portal.arch.root", rootDir.absolutePath)
    systemProperty("portal.arch.modules", productModules.joinToString(","))
    systemProperty("portal.arch.classes", productModules.joinToString(",") { project(":$it").layout.buildDirectory.dir("classes/java/main").get().asFile.absolutePath })
}
