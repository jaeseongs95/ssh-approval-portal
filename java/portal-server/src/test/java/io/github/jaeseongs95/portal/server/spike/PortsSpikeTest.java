package io.github.jaeseongs95.portal.server.spike;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.stereotype.Component;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;

/**
 * Spike (b), cases Q-01 .. Q-05 of docs/migration/foundation-cases.md: one non-web parent context and two child web contexts, each child with its own embedded
 * web server on its own port (0 = a free port here; 39124 and 39125 in the product). The parent holds what both share: auto-configured infrastructure
 * (the DataSource of portal-store) and a bean. Each child holds only its own web layer.
 */
class PortsSpikeTest {

    /** Shared state of the parent: both web layers must see this one instance. A component of ours, found by the parent's registration, not made by a factory. */
    @Component
    static class SharedCounter {
        private final AtomicInteger value = new AtomicInteger();

        int increment() {
            return value.incrementAndGet();
        }

        int get() {
            return value.get();
        }
    }

    @Configuration(proxyBeanMethods = false)
    @EnableAutoConfiguration
    @Import(SharedCounter.class)
    static class ParentConfiguration {
    }

    @RestController
    static class CountController {
        private final SharedCounter counter;

        CountController(SharedCounter counter) {
            this.counter = counter;
        }

        @PostMapping("/count")
        int increment() {
            return counter.increment();
        }
    }

    @Configuration(proxyBeanMethods = false)
    @EnableAutoConfiguration
    @Import(CountController.class)
    static class McpChildConfiguration {
    }

    @RestController
    static class ApiController {
        private final SharedCounter counter;

        ApiController(SharedCounter counter) {
            this.counter = counter;
        }

        @GetMapping("/api/x")
        String x() {
            return "admin";
        }

        @GetMapping("/api/count")
        int count() {
            return counter.get();
        }
    }

    @Configuration(proxyBeanMethods = false)
    @EnableAutoConfiguration
    @Import(ApiController.class)
    static class AdminChildConfiguration {
    }

    record Reply(int status, String body) {
    }

    private static ConfigurableApplicationContext parent;
    private static ConfigurableApplicationContext mcp;
    private static ConfigurableApplicationContext admin;
    private static RestClient mcpHttp;
    private static RestClient adminHttp;

    @BeforeAll
    static void start() {
        // The parent is not a web application and has the MCP server off; the children set their own server.port and decide for themselves whether they are MCP.
        parent = new SpringApplicationBuilder(ParentConfiguration.class).web(WebApplicationType.NONE)
            .properties("spring.ai.mcp.server.enabled=false", "spring.main.banner-mode=off").run();
        mcp = new SpringApplicationBuilder(McpChildConfiguration.class).parent(parent).web(WebApplicationType.SERVLET)
            .properties("server.port=0", "spring.ai.mcp.server.enabled=true", "spring.ai.mcp.server.protocol=STREAMABLE", "spring.ai.mcp.server.name=spike-mcp",
                "spring.main.banner-mode=off")
            .run();
        admin = new SpringApplicationBuilder(AdminChildConfiguration.class).parent(parent).web(WebApplicationType.SERVLET)
            .properties("server.port=0", "spring.ai.mcp.server.enabled=false", "spring.main.banner-mode=off")
            .run();
        mcpHttp = RestClient.create("http://127.0.0.1:" + port(mcp));
        adminHttp = RestClient.create("http://127.0.0.1:" + port(admin));
    }

    @AfterAll
    static void stop() {
        // Closing the parent closes the children first (a child is closed with its parent).
        parent.close();
    }

    private static int port(ConfigurableApplicationContext child) {
        return ((WebServerApplicationContext) child).getWebServer().getPort();
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
    void q01_threeContextsStartAndTheChildrenHaveTheirOwnPorts() {
        assertThat(parent.isActive() && mcp.isActive() && admin.isActive()).isTrue();
        assertThat(mcp.getParent()).isSameAs(parent);
        assertThat(admin.getParent()).isSameAs(parent);
        assertThat(port(mcp)).isPositive();
        assertThat(port(admin)).isPositive();
        assertThat(port(mcp)).isNotEqualTo(port(admin));
        assertThat(parent).as("the parent is not a web server context").isNotInstanceOf(WebServerApplicationContext.class);
        assertThat(((WebServerApplicationContext) mcp).getWebServer()).isNotSameAs(((WebServerApplicationContext) admin).getWebServer());
    }

    @Test
    void q02_theMcpPortAnswersMcpPathsAndKnowsNothingOfTheAdminApi() {
        Reply initialize = post(mcpHttp, "/mcp", "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\","
            + "\"capabilities\":{},\"clientInfo\":{\"name\":\"spike\",\"version\":\"1\"}}}");
        assertThat(initialize.status()).isEqualTo(200);
        assertThat(initialize.body()).contains("\"serverInfo\"").contains("spike-mcp");
        assertThat(get(mcpHttp, "/api/x").status()).isEqualTo(404);
        assertThat(get(mcpHttp, "/api/count").status()).isEqualTo(404);
    }

    @Test
    void q03_theAdminPortAnswersAdminPathsAndKnowsNothingOfMcp() {
        Reply x = get(adminHttp, "/api/x");
        assertThat(x.status()).isEqualTo(200);
        assertThat(x.body()).isEqualTo("admin");
        assertThat(get(adminHttp, "/mcp").status()).isEqualTo(404);
        assertThat(post(adminHttp, "/mcp", "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}").status()).isEqualTo(404);
        assertThat(post(adminHttp, "/count", "{}").status()).as("the /count of the MCP child is not served on the admin port").isIn(404, 405);
    }

    @Test
    void q04_theParentBeansAreSharedByBothChildren() {
        SharedCounter fromParent = parent.getBean(SharedCounter.class);
        assertThat(mcp.getBean(SharedCounter.class)).isSameAs(fromParent);
        assertThat(admin.getBean(SharedCounter.class)).isSameAs(fromParent);
        // The infrastructure auto-configured in the parent (portal-store's DataSource) is the one the children use; neither child makes its own.
        DataSource dataSource = parent.getBean(DataSource.class);
        assertThat(mcp.getBean(DataSource.class)).isSameAs(dataSource);
        assertThat(admin.getBean(DataSource.class)).isSameAs(dataSource);
        assertThat(mcp.getBeanFactory().containsLocalBean("dataSource")).isFalse();
        assertThat(admin.getBeanFactory().containsLocalBean("dataSource")).isFalse();
        // The same state through the two ports: a request on the MCP port changes what a request on the admin port reads.
        int before = Integer.parseInt(get(adminHttp, "/api/count").body());
        assertThat(post(mcpHttp, "/count", "{}").status()).isEqualTo(200);
        assertThat(Integer.parseInt(get(adminHttp, "/api/count").body())).isEqualTo(before + 1);
    }

    @Test
    void q05_closingTheParentClosesBothPorts() {
        ConfigurableApplicationContext parent2 = new SpringApplicationBuilder(ParentConfiguration.class).web(WebApplicationType.NONE)
            .properties("spring.ai.mcp.server.enabled=false", "spring.main.banner-mode=off").run();
        ConfigurableApplicationContext child1 = new SpringApplicationBuilder(AdminChildConfiguration.class).parent(parent2).web(WebApplicationType.SERVLET)
            .properties("server.port=0", "spring.ai.mcp.server.enabled=false", "spring.main.banner-mode=off").run();
        ConfigurableApplicationContext child2 = new SpringApplicationBuilder(AdminChildConfiguration.class).parent(parent2).web(WebApplicationType.SERVLET)
            .properties("server.port=0", "spring.ai.mcp.server.enabled=false", "spring.main.banner-mode=off").run();
        RestClient first = RestClient.create("http://127.0.0.1:" + port(child1));
        RestClient second = RestClient.create("http://127.0.0.1:" + port(child2));
        assertThat(get(first, "/api/x").status()).isEqualTo(200);
        assertThat(get(second, "/api/x").status()).isEqualTo(200);
        parent2.close();
        assertThat(child1.isActive()).isFalse();
        assertThat(child2.isActive()).isFalse();
        assertThatThrownBy(() -> get(first, "/api/x")).isInstanceOf(ResourceAccessException.class);
        assertThatThrownBy(() -> get(second, "/api/x")).isInstanceOf(ResourceAccessException.class);
    }
}
