package io.github.jaeseongs95.portal.web.nullspike;

import static org.assertj.core.api.Assertions.assertThat;

import io.modelcontextprotocol.json.McpJsonMapper;
import io.modelcontextprotocol.json.jackson3.JacksonMcpJsonMapper;
import io.modelcontextprotocol.server.McpServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.spec.McpSchema;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Case P-10 of docs/migration/foundation-cases.md: how null properties of a record reach the wire in {@code structuredContent}. A tool returns a record that has a null
 * property and no @JsonInclude; the same value is also written as text by Boot's JsonMapper. Its own package, so that the scan of the contract spike does not pick it up.
 */
@SpringBootTest(classes = NullInclusionSpikeTest.App.class, webEnvironment = WebEnvironment.RANDOM_PORT)
class NullInclusionSpikeTest {

    record Plain(String a, String b) {
    }

    @SpringBootApplication
    static class App {
        // A @Bean factory: SyncToolSpecification is a library type that cannot carry @Component.
        @Bean
        List<SyncToolSpecification> plainTool(JsonMapper jsonMapper) {
            McpJsonMapper mcpJson = new JacksonMcpJsonMapper(jsonMapper);
            Plain plain = new Plain("x", null);
            return List.of(SyncToolSpecification.builder()
                .tool(McpSchema.Tool.builder("plain", mcpJson, "{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false}").description("A record with a null.").build())
                .callHandler((exchange, request) -> McpSchema.CallToolResult.builder().structuredContent(plain).addTextContent(jsonMapper.writeValueAsString(plain)).build())
                .build());
        }
    }

    @LocalServerPort
    int port;

    @Autowired
    JsonMapper json;

    @Test
    void p10_structuredContentLeavesNullsOutWhileBootsMapperWritesThem() {
        RestClient http = RestClient.create("http://127.0.0.1:" + port);
        var initialize = exchange(http, null, Map.of("jsonrpc", "2.0", "id", 1, "method", "initialize", "params",
            Map.of("protocolVersion", "2025-06-18", "capabilities", Map.of(), "clientInfo", Map.of("name", "spike", "version", "1"))));
        String session = initialize.session();
        exchange(http, session, Map.of("jsonrpc", "2.0", "method", "notifications/initialized"));
        JsonNode result = payload(exchange(http, session, Map.of("jsonrpc", "2.0", "id", 2, "method", "tools/call", "params", Map.of("name", "plain", "arguments", Map.of()))))
            .path("result");
        assertThat(result.path("content").get(0).path("text").asString()).as("text written by Boot's JsonMapper").isEqualTo("{\"a\":\"x\",\"b\":null}");
        assertThat(result.path("structuredContent").has("b")).as("structuredContent written by the MCP server: null property %s", result.path("structuredContent")).isFalse();
        assertThat(result.path("structuredContent").path("a").asString()).isEqualTo("x");
    }

    private record Reply(String session, String body, MediaType type) {
    }

    private Reply exchange(RestClient http, String session, Map<String, Object> message) {
        return http.post().uri("/mcp").contentType(MediaType.APPLICATION_JSON).accept(MediaType.APPLICATION_JSON, MediaType.TEXT_EVENT_STREAM)
            .headers(headers -> {
                if (session != null) {
                    headers.set("Mcp-Session-Id", session);
                }
            })
            .body(json.writeValueAsString(message))
            .exchange((request, response) -> new Reply(response.getHeaders().getFirst("Mcp-Session-Id"),
                new String(response.getBody().readAllBytes(), StandardCharsets.UTF_8), response.getHeaders().getContentType()), true);
    }

    private JsonNode payload(Reply reply) {
        if (reply.type() != null && MediaType.TEXT_EVENT_STREAM.isCompatibleWith(reply.type())) {
            StringBuilder data = new StringBuilder();
            reply.body().lines().filter(line -> line.startsWith("data:")).forEach(line -> data.append(line.substring(5).stripLeading()));
            return json.readTree(data.toString());
        }
        return json.readTree(reply.body());
    }
}
