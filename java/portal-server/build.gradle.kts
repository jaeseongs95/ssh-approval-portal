// Assembly: the executable jar. Two web servers (MCP 39124, admin 39125) run as two child contexts of one parent context; the arrangement is chosen by
// the spike test PortsSpikeTest (docs/migration/foundation-cases.md, cases Q-*).
plugins {
    id("org.springframework.boot")
}

val springAiVersion = property("springAiVersion")

dependencies {
    implementation(project(":portal-domain"))
    implementation(project(":portal-app"))
    implementation(project(":portal-store"))
    implementation(project(":portal-ssh"))
    implementation(project(":portal-desktop"))
    implementation(project(":portal-web"))
    implementation(platform("org.springframework.ai:spring-ai-bom:$springAiVersion"))
    // No mock is used (Principles 7.1); see portal-web/build.gradle.kts for the Mockito self-attach warning this avoids.
    testImplementation("org.springframework.boot:spring-boot-starter-test") {
        exclude(group = "org.mockito")
    }
}

tasks.named<org.springframework.boot.gradle.tasks.bundling.BootJar>("bootJar") {
    archiveFileName = "portal-server.jar"
    manifest {
        attributes("Implementation-Version" to project.version)
    }
}
