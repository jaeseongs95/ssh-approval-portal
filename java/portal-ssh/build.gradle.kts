// SSH adapter on Apache MINA SSHD: exec with deadline and cancel, SFTP file operations, direct-tcpip forwarding, host key TOFU.
dependencies {
    api(project(":portal-app"))
    // Not in the Spring Boot BOM (spring-boot-dependencies-4.1.2.pom has no org.apache.sshd entry). 2.20.1 is the newest 2.x GA release on Maven Central
    // (maven-metadata.xml of org.apache.sshd:sshd-core, 2026-11-12); the 3.0.0 line is milestones only (M7), which Principles 8.1 does not allow.
    implementation("org.apache.sshd:sshd-core:2.20.1")
    implementation("org.apache.sshd:sshd-sftp:2.20.1")
    // ssh-ed25519 (the default host and user key type of current OpenSSH, and first in the 2.x host key list) needs an EdDSA provider that MINA finds by itself:
    // sshd-core has no EdDSA signature of its own, so BuiltinSignatures.ed25519.isSupported() is false without one (pilot P3-3). MINA 2.20.1 registers either BouncyCastle
    // (BouncyCastleSecurityProviderRegistrar, BouncyCastleEdDSASupport) or net.i2p.crypto:eddsa (unmaintained); BouncyCastle is the maintained one and is what the MINA 2.20.1
    // build itself is tested with (bouncycastle.version 1.86 in its pom.xml; 1.87 is a day old on 2026-11-12). It is not in the Spring Boot BOM
    // (spring-boot-dependencies-4.1.2.pom has no org.bouncycastle entry). Runtime only: MINA loads it by reflection, no product code names a BouncyCastle class.
    // bcpkix is not added: it is needed only for encrypted PEM key files, which the profile design does not use.
    runtimeOnly("org.bouncycastle:bcprov-jdk18on:1.86")
    // ssh.profile.TomlProfileLoader reads the 2.x profile TOML with Jackson's TOML data format (no hand-written parser, Principles 2.2 category 13); the version is the one of the
    // tools.jackson:jackson-bom that the Spring Boot BOM manages.
    implementation("tools.jackson.dataformat:jackson-dataformat-toml")
    // The profile schema is checked with Jakarta Validation (jakarta.validation.Validator, Principles 2.2 category 9); the starter brings the Hibernate Validator implementation
    // at the Boot BOM's version.
    implementation("org.springframework.boot:spring-boot-starter-validation")
    // testImplementation, not testRuntimeOnly: LoggingHostKeyEventsTest attaches a logback ListAppender, so the logback classes are on the test compile class path.
    testImplementation("ch.qos.logback:logback-classic")
}

// ---- realOpenSshTest: the tests that need a real OpenSSH server (stage 3 design 7.2 and 7.3, cases S3-RO-nn and S3-RW-nn) ----
// A source set of its own (src/realOpenSsh/java) and a test task of its own, so that the default test task never meets a missing server and no test is skipped by a condition.
// Not part of check or build: a person or the CI job of stage 8 calls it by name, on a machine where an OpenSSH server runs (the CI preparation scripts of the java/ci folder
// start it). Like externalDbmsTest of portal-store, the connection is described by Gradle properties (this PC: the gradle.properties of the dedicated Gradle user home;
// CI: -P or ORG_GRADLE_PROJECT_*), and nothing stands in for a missing server:
//   portal.test.openssh.host         the host name or address of the server
//   portal.test.openssh.port         its port
//   portal.test.openssh.user         the account the tests log in as
//   portal.test.openssh.key-file     the PATH of the private key file of that account
//   portal.test.openssh.known-hosts  the PATH of the known_hosts file that holds the server's host key
//   portal.test.openssh.platform     the operating system of the server: linux or windows
// This script never reads the key file: the paths go to the test JVM as system properties and the tests read what they point to. A missing property fails the task with a
// message. A run in which Gradle finds no test fails as well (Test.failOnNoDiscoveredTests, https://docs.gradle.org/current/dsl/org.gradle.api.tasks.testing.Test.html).
val javaSourceSets = extensions.getByType<SourceSetContainer>()
val realOpenSshSourceSet = javaSourceSets.create("realOpenSsh") {
    compileClasspath += javaSourceSets.getByName("main").output
    runtimeClasspath += javaSourceSets.getByName("main").output
}

// The tests of this source set see what the unit tests see (JUnit, AssertJ, the BOM, MINA, the logging back end), so they are written the same way.
configurations.named("realOpenSshImplementation") { extendsFrom(configurations.getByName("testImplementation")) }
configurations.named("realOpenSshRuntimeOnly") { extendsFrom(configurations.getByName("testRuntimeOnly")) }

val openSshSettings = listOf("host", "port", "user", "key-file", "known-hosts", "platform")
    .associateWith { providers.gradleProperty("portal.test.openssh.$it") }

tasks.register<Test>("realOpenSshTest") {
    description = "Runs the tests against a real OpenSSH server (Gradle properties portal.test.openssh.host, .port, .user, .key-file, .known-hosts, .platform); not part of check."
    group = "verification"
    testClassesDirs = realOpenSshSourceSet.output.classesDirs
    classpath = realOpenSshSourceSet.runtimeClasspath
    maxParallelForks = 1 // the tests share one account on one server
    failOnNoDiscoveredTests = true
    // A run against a live server is never up to date and never taken from a cache (Task.doNotTrackState, https://docs.gradle.org/current/javadoc/org/gradle/api/Task.html).
    doNotTrackState("The result depends on the state of an external OpenSSH server")

    val forked = this
    doFirst {
        val missing = openSshSettings.filterValues { !it.isPresent }.keys.map { "portal.test.openssh.$it" }
        if (missing.isNotEmpty()) {
            throw GradleException(
                "realOpenSshTest needs the Gradle properties $missing. Set them in the gradle.properties of the Gradle user home or pass them with -P: the server's host and port, " +
                    "the account, the path of its private key file, the path of the known_hosts file with the server's host key, and the platform (linux or windows). " +
                    "The task starts no server and never falls back to the embedded test server.",
            )
        }
        openSshSettings.forEach { (name, value) -> forked.systemProperty("portal.test.openssh.$name", value.get()) }
    }
}
