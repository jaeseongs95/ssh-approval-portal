// Use cases: @Service and @Transactional classes, the port interfaces the adapters implement, the Clock / SecureRandom / digest beans, the events published
// after commit, the scheduled work. It knows no MCP, no HTTP, no SSH library and no operating system.
dependencies {
    api(project(":portal-domain"))
    api("org.springframework:spring-context")
    api("org.springframework:spring-tx")
}
