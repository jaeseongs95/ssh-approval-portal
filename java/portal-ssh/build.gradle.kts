// SSH adapter on Apache MINA SSHD: exec with deadline and cancel, SFTP file operations, direct-tcpip forwarding, host key TOFU.
dependencies {
    api(project(":portal-app"))
    // Not in the Spring Boot BOM (spring-boot-dependencies-4.1.2.pom has no org.apache.sshd entry). 2.20.1 is the newest 2.x GA release on Maven Central
    // (maven-metadata.xml of org.apache.sshd:sshd-core, 2026-11-12); the 3.0.0 line is milestones only (M7), which Principles 8.1 does not allow.
    implementation("org.apache.sshd:sshd-core:2.20.1")
    implementation("org.apache.sshd:sshd-sftp:2.20.1")
    testRuntimeOnly("ch.qos.logback:logback-classic")
}
