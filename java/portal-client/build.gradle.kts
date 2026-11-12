// The PC client: hook entry per host, the completion inbox (H2 file database), upload, observe, ACK, device registration. It knows the domain records only;
// it never depends on the server's modules.
dependencies {
    api(project(":portal-domain"))
    implementation("org.springframework.boot:spring-boot-starter")
    runtimeOnly("com.h2database:h2")
}
