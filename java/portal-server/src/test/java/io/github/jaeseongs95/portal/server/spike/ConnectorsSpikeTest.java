package io.github.jaeseongs95.portal.server.spike;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import org.apache.catalina.connector.Connector;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClient;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Spike (b), the alternative of case Q-06/Q-07: one context, one embedded Tomcat, a second connector added by a WebServerFactoryCustomizer (Boot how-to "Enable
 * Multiple Connectors with Tomcat"). Both ports reach the same DispatcherServlet, so the paths of each port are restricted by a filter that reads the local port
 * of the request. The criterion is the same as for the child contexts: the MCP endpoint must not answer on the admin port, the admin path not on the MCP port.
 */
class ConnectorsSpikeTest {

    private static int mcpPort;
    private static int adminPort;

    @RestController
    static class AdminController {
        @GetMapping("/api/x")
        String x() {
            return "admin";
        }
    }

    /** 404 for what does not belong to the port the request came in on. */
    static class PortScopeFilter extends OncePerRequestFilter {
        @Override
        protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
            String path = request.getRequestURI();
            boolean mcpPath = path.equals("/mcp"), adminPath = path.startsWith("/api");
            if (request.getLocalPort() == adminPort && mcpPath || request.getLocalPort() == mcpPort && adminPath) {
                response.sendError(HttpServletResponse.SC_NOT_FOUND);
                return;
            }
            chain.doFilter(request, response);
        }
    }

    @Configuration(proxyBeanMethods = false)
    @EnableAutoConfiguration
    @Import(AdminController.class)
    static class SingleContextConfiguration {
        // A @Bean factory: the port is a value of the test, and a Tomcat Connector is a library object that cannot carry @Component (Boot how-to, multiple connectors).
        @Bean
        WebServerFactoryCustomizer<TomcatServletWebServerFactory> adminConnector() {
            return tomcat -> {
                Connector connector = new Connector("org.apache.coyote.http11.Http11NioProtocol");
                connector.setPort(adminPort);
                tomcat.addAdditionalConnectors(connector);
            };
        }

        // A @Bean factory: FilterRegistrationBean states the URL pattern and the order of the filter (Principles 3.8); it is a library type.
        @Bean
        FilterRegistrationBean<PortScopeFilter> portScope() {
            FilterRegistrationBean<PortScopeFilter> registration = new FilterRegistrationBean<>(new PortScopeFilter());
            registration.addUrlPatterns("/*");
            registration.setOrder(0);
            return registration;
        }
    }

    record Reply(int status, String body) {
    }

    private static ConfigurableApplicationContext context;
    private static RestClient mcpHttp;
    private static RestClient adminHttp;

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    @BeforeAll
    static void start() throws IOException {
        mcpPort = freePort();
        adminPort = freePort();
        context = new SpringApplicationBuilder(SingleContextConfiguration.class).web(WebApplicationType.SERVLET)
            .properties("server.port=" + mcpPort, "spring.ai.mcp.server.enabled=true", "spring.ai.mcp.server.protocol=STREAMABLE", "spring.main.banner-mode=off")
            .run();
        mcpHttp = RestClient.create("http://127.0.0.1:" + mcpPort);
        adminHttp = RestClient.create("http://127.0.0.1:" + adminPort);
    }

    @AfterAll
    static void stop() {
        context.close();
    }

    private static Reply get(RestClient client, String path) {
        return client.get().uri(path).exchange((request, response) -> new Reply(response.getStatusCode().value(),
            new String(response.getBody().readAllBytes(), StandardCharsets.UTF_8)), true);
    }

    private static Reply post(RestClient client, String path, String body) {
        return client.post().uri(path).contentType(MediaType.APPLICATION_JSON).accept(MediaType.APPLICATION_JSON, MediaType.TEXT_EVENT_STREAM).body(body)
            .exchange((request, response) -> new Reply(response.getStatusCode().value(), new String(response.getBody().readAllBytes(), StandardCharsets.UTF_8)), true);
    }

    @Test
    void q07_oneContextTwoConnectorsWithPathsRestrictedPerPort() {
        String initialize = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\","
            + "\"capabilities\":{},\"clientInfo\":{\"name\":\"spike\",\"version\":\"1\"}}}";
        assertThat(mcpPort).isNotEqualTo(adminPort);
        assertThat(post(mcpHttp, "/mcp", initialize).status()).as("MCP endpoint on the MCP port").isEqualTo(200);
        assertThat(get(mcpHttp, "/api/x").status()).as("admin path on the MCP port").isEqualTo(404);
        assertThat(get(adminHttp, "/api/x").status()).as("admin path on the admin port").isEqualTo(200);
        assertThat(post(adminHttp, "/mcp", initialize).status()).as("MCP endpoint on the admin port").isEqualTo(404);
        assertThat(get(adminHttp, "/mcp").status()).as("MCP endpoint (GET) on the admin port").isEqualTo(404);
    }
}
