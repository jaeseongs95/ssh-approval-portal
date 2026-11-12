// The 2.x SQLite -> 3.0 migration command. The only module that reads SQLite: the driver stays out of the server and the client.
dependencies {
    api(project(":portal-store"))
    implementation(project(":portal-domain"))
    implementation("org.springframework.boot:spring-boot-starter")
    // The version is the Boot BOM's (sqlite-jdbc.version).
    implementation("org.xerial:sqlite-jdbc")
}
