// Web adapter: the MCP server (Spring AI, Streamable HTTP), the admin MVC API, the MCP Apps card resources. spring-security, the device tokens and the
// static admin UI arrive with the web module's own step (plan step 4); a security starter on the classpath now would lock /mcp behind a generated password
// before any authentication design exists.
val springAiVersion = property("springAiVersion")

dependencies {
    api(project(":portal-app"))
    implementation(platform("org.springframework.ai:spring-ai-bom:$springAiVersion"))
    api("org.springframework.ai:spring-ai-starter-mcp-server-webmvc")
    api("org.springframework.boot:spring-boot-starter-webmvc")
    api("org.springframework.boot:spring-boot-starter-validation")
    testImplementation("org.springframework.boot:spring-boot-starter-test")
}
