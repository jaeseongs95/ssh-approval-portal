package io.github.jaeseongs95.portal.web.spike;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Spike (a), cases P-01 .. P-09 of docs/migration/foundation-cases.md: can the Spring AI MCP server (webmvc, Streamable HTTP, /mcp) present the tools, the
 * input schemas, the tool _meta, the ui:// resource and the result shape of Contract 2.0? Real HTTP to the started server; JSON-RPC by hand so that the test
 * sees the raw wire JSON, not a client library's model of it.
 */
@SpringBootTest(classes = SpikeApplication.class, webEnvironment = WebEnvironment.RANDOM_PORT)
class McpContractSpikeTest {

    private static final String PROTOCOL_VERSION = "2025-06-18";

    @LocalServerPort
    int port;

    @Autowired
    JsonMapper json;

    private RestClient http;
    private String sessionId;
    private String negotiatedVersion;
    private int nextId = 1;

    record Reply(int status, HttpHeaders headers, String body) {
    }

    @BeforeEach
    void connect() {
        http = RestClient.create("http://127.0.0.1:" + port);
        Reply reply = post(request("initialize", Map.of("protocolVersion", PROTOCOL_VERSION, "capabilities", Map.of(),
            "clientInfo", Map.of("name", "spike-client", "version", "1.0.0"))), false);
        assertThat(reply.status()).as("initialize status").isEqualTo(200);
        sessionId = reply.headers().getFirst("Mcp-Session-Id");
        negotiatedVersion = payload(reply).path("result").path("protocolVersion").asString();
        Reply initialized = post(Map.of("jsonrpc", "2.0", "method", "notifications/initialized"), true);
        assertThat(initialized.status()).as("notifications/initialized status").isEqualTo(202);
    }

    @Test
    void p01_initializeOpensASessionAndDeclaresToolsAndResources() {
        // connect() already ran initialize; ask again on a second connection to read the whole reply.
        Reply reply = post(request("initialize", Map.of("protocolVersion", PROTOCOL_VERSION, "capabilities", Map.of(),
            "clientInfo", Map.of("name", "spike-client-2", "version", "1.0.0"))), false);
        JsonNode result = payload(reply).path("result");
        assertThat(reply.headers().getFirst("Mcp-Session-Id")).as("a session id is assigned").isNotBlank();
        assertThat(sessionId).isNotBlank();
        assertThat(result.path("capabilities").has("tools")).as("tools capability").isTrue();
        assertThat(result.path("capabilities").has("resources")).as("resources capability").isTrue();
        assertThat(result.path("serverInfo").path("name").asString()).isEqualTo("ssh-approval-portal-spike");
        // The version the server answers with: a client that asks for a version the server speaks gets it back; the newest one the SDK declares is 2025-11-25.
        assertThat(result.path("protocolVersion").asString()).isEqualTo(PROTOCOL_VERSION);
        Reply newest = post(request("initialize", Map.of("protocolVersion", "2025-11-25", "capabilities", Map.of(),
            "clientInfo", Map.of("name", "spike-client-3", "version", "1.0.0"))), false);
        assertThat(payload(newest).path("result").path("protocolVersion").asString()).isEqualTo("2025-11-25");
    }

    @Test
    void p02_toolsListNamesTheTwoTools() {
        assertThat(toolNames(listTools())).containsExactlyInAnyOrder("targets", "submit");
    }

    @Test
    void p03_inputSchemasAreJsonEqualToTheContractSchemas() {
        JsonNode tools = listTools();
        assertThat(tool(tools, "targets").path("inputSchema")).isEqualTo(resource("contract-spike/targets.input.schema.json"));
        assertThat(tool(tools, "submit").path("inputSchema")).isEqualTo(resource("contract-spike/submit.input.schema.json"));
    }

    @Test
    void p04_theConstraintsOfPublicContractAreKeptVerbatim() {
        JsonNode schema = tool(listTools(), "submit").path("inputSchema");
        JsonNode properties = schema.path("properties");
        assertThat(schema.path("additionalProperties").isBoolean()).isTrue();
        assertThat(schema.path("additionalProperties").asBoolean(true)).isFalse();
        assertThat(schema.path("required")).isEqualTo(json.readTree("[\"kind\",\"operationKey\"]"));
        assertThat(properties.path("operationKey").path("pattern").asString()).isEqualTo("^[A-Za-z0-9_.:-]{16,128}(?![\\s\\S])");
        assertThat(properties.path("kind").path("enum")).isEqualTo(json.readTree("[\"command\",\"source\",\"download\"]"));
        assertThat(properties.path("target").path("pattern").asString()).isEqualTo("^[a-z][a-z0-9_-]{0,31}$");
        assertThat(properties.path("expectedTargetRevision").path("pattern").asString()).isEqualTo("^[a-f0-9]{64}$");
        assertThat(properties.path("argv").path("maxItems").asInt()).isEqualTo(16);
        assertThat(properties.path("argv").path("items").path("maxLength").asInt()).isEqualTo(512);
        assertThat(properties.path("command").path("minLength").asInt()).isEqualTo(1);
        assertThat(properties.path("command").path("maxLength").asInt()).isEqualTo(32768);
        assertThat(properties.path("source").path("maxLength").asInt()).isEqualTo(16384);
        assertThat(properties.path("context").path("maxLength").asInt()).isEqualTo(8192);
        assertThat(properties.path("remotePath").path("maxLength").asInt()).isEqualTo(4096);
    }

    @Test
    void p05_aToolMetaIsSentAsGiven() {
        JsonNode targets = tool(listTools(), "targets");
        assertThat(targets.path("_meta")).isEqualTo(json.valueToTree(SpikeMcpConfiguration.TARGETS_TOOL_META));
        assertThat(tool(listTools(), "submit").has("_meta")).as("a tool without meta sends none").isFalse();
    }

    @Test
    void p06_resourcesListKeepsTheUriAndTheMcpAppMimeType() {
        JsonNode resources = result(request("resources/list", Map.of())).path("resources");
        assertThat(resources).hasSize(1);
        assertThat(resources.get(0).path("uri").asString()).isEqualTo("ui://ssh-approval/card-test.html");
        assertThat(resources.get(0).path("mimeType").asString()).isEqualTo("text/html;profile=mcp-app");
    }

    @Test
    void p07_resourcesReadReturnsTheHtmlTheMimeTypeAndTheUiMeta() {
        JsonNode contents = result(request("resources/read", Map.of("uri", SpikeMcpConfiguration.CARD_URI))).path("contents");
        assertThat(contents).hasSize(1);
        assertThat(contents.get(0).path("mimeType").asString()).isEqualTo("text/html;profile=mcp-app");
        assertThat(contents.get(0).path("text").asString()).isEqualTo(SpikeMcpConfiguration.CARD_HTML);
        assertThat(contents.get(0).path("_meta")).isEqualTo(json.valueToTree(SpikeMcpConfiguration.CARD_CONTENT_META));
    }

    @Test
    void p08_toolCallCarriesStructuredContentAndTheSameJsonAsText() {
        JsonNode result = result(request("tools/call", Map.of("name", "targets", "arguments", Map.of())));
        assertThat(result.path("isError").asBoolean(false)).isFalse();
        JsonNode structured = result.path("structuredContent");
        JsonNode text = result.path("content").get(0);
        assertThat(structured.isObject()).as("structuredContent present").isTrue();
        assertThat(text.path("type").asString()).isEqualTo("text");
        assertThat(json.readTree(text.path("text").asString())).as("content[0].text parsed equals structuredContent").isEqualTo(structured);
        assertThat(structured.path("contractVersion").asString()).isEqualTo("2.0");
        assertThat(structured.path("ok").asBoolean()).isTrue();
        assertThat(structured.path("error").isNull()).as("error is an explicit null in the envelope").isTrue();
    }

    @Test
    void p09_anInputThatBreaksTheSchemaIsRefusedBeforeTheHandlerRuns() {
        // additionalProperties:false and the operationKey pattern: the handler of the spike would echo anything it receives.
        JsonNode unknownField = answer(request("tools/call", Map.of("name", "submit", "arguments", Map.of("kind", "command", "operationKey", "abcdefghijklmnop1234", "bogus", 1))));
        JsonNode shortKey = answer(request("tools/call", Map.of("name", "submit", "arguments", Map.of("kind", "command", "operationKey", "short"))));
        assertThat(refused(unknownField)).as("unknown field refused: %s", unknownField).isTrue();
        assertThat(refused(shortKey)).as("pattern violation refused: %s", shortKey).isTrue();
    }

    private static boolean refused(JsonNode answer) {
        return answer.has("error") || answer.path("result").path("isError").asBoolean(false);
    }

    private JsonNode listTools() {
        return result(request("tools/list", Map.of())).path("tools");
    }

    private static List<String> toolNames(JsonNode tools) {
        List<String> names = new ArrayList<>();
        tools.forEach(tool -> names.add(tool.path("name").asString()));
        return names;
    }

    private static JsonNode tool(JsonNode tools, String name) {
        for (JsonNode tool : tools) {
            if (name.equals(tool.path("name").asString())) {
                return tool;
            }
        }
        throw new AssertionError("no tool named " + name);
    }

    private JsonNode resource(String path) {
        try {
            return json.readTree(new ClassPathResource(path).getContentAsString(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new UncheckedIOException("cannot read " + path, e);
        }
    }

    private Map<String, Object> request(String method, Map<String, Object> params) {
        return Map.of("jsonrpc", "2.0", "id", nextId++, "method", method, "params", params);
    }

    private JsonNode result(Map<String, Object> request) {
        JsonNode answer = answer(request);
        assertThat(answer.has("error")).as("JSON-RPC error: %s", answer).isFalse();
        return answer.path("result");
    }

    private JsonNode answer(Map<String, Object> request) {
        Reply reply = post(request, true);
        assertThat(reply.status()).as("HTTP status of %s", request.get("method")).isLessThan(500);
        return payload(reply);
    }

    private Reply post(Map<String, Object> message, boolean inSession) {
        return http.post().uri("/mcp").contentType(MediaType.APPLICATION_JSON)
            .accept(MediaType.APPLICATION_JSON, MediaType.TEXT_EVENT_STREAM)
            .headers(headers -> {
                if (inSession) {
                    headers.set("Mcp-Session-Id", sessionId);
                    headers.set("MCP-Protocol-Version", negotiatedVersion);
                }
            })
            .body(json.writeValueAsString(message))
            .exchange((request, response) -> new Reply(response.getStatusCode().value(), response.getHeaders(),
                new String(response.getBody().readAllBytes(), StandardCharsets.UTF_8)), true);
    }

    /** The JSON-RPC message of a reply: a plain JSON body, or the data lines of the one SSE event (MCP transports: the server picks either). */
    private JsonNode payload(Reply reply) {
        if (reply.body().isBlank()) {
            return json.createObjectNode();
        }
        MediaType type = reply.headers().getContentType();
        if (type != null && MediaType.TEXT_EVENT_STREAM.isCompatibleWith(type)) {
            StringBuilder data = new StringBuilder();
            reply.body().lines().filter(line -> line.startsWith("data:")).forEach(line -> data.append(line.substring(5).stripLeading()));
            return json.readTree(data.toString());
        }
        return json.readTree(reply.body());
    }
}
