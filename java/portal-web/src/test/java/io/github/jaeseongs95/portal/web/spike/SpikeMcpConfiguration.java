package io.github.jaeseongs95.portal.web.spike;

import io.modelcontextprotocol.json.McpJsonMapper;
import io.modelcontextprotocol.json.jackson3.JacksonMcpJsonMapper;
import io.modelcontextprotocol.server.McpServerFeatures.SyncResourceSpecification;
import io.modelcontextprotocol.server.McpServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.spec.McpSchema;
import java.util.List;
import java.util.Map;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import tools.jackson.databind.json.JsonMapper;

/**
 * Wiring of what the web module will do for Contract 2.0, reduced to two tools and one resource: low-level {@code SyncToolSpecification} beans whose inputSchema is
 * the JSON Schema text moved from the Zod definitions of src/adapters/mcp/public-contract.mjs, a tool {@code _meta}, a {@code ui://} resource with mimeType
 * text/html;profile=mcp-app, and results that carry structuredContent and the same JSON as text. The logic lives in the components (ToolResults, ContractSchemas,
 * ContractEnvelope); this class only assembles library objects.
 */
@Configuration(proxyBeanMethods = false)
class SpikeMcpConfiguration {

    static final String CARD_URI = "ui://ssh-approval/card-test.html";
    static final String CARD_MIME_TYPE = "text/html;profile=mcp-app";
    static final String CARD_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><title>card</title></head><body>card</body></html>";
    static final Map<String, Object> CARD_CONTENT_META = Map.of("ui", Map.of("csp", Map.of("connectDomains", List.of(), "resourceDomains", List.of()), "prefersBorder", true));
    static final Map<String, Object> TARGETS_TOOL_META = Map.of("ui", Map.of("resourceUri", CARD_URI, "visibility", List.of("model", "app")));

    // A @Bean factory: SyncToolSpecification is a library type that cannot carry @Component, and one list bean is the shape the Spring AI MCP starter reads
    // ("@Bean public List<McpServerFeatures.SyncToolSpecification> myTools" in its documentation).
    @Bean
    List<SyncToolSpecification> spikeTools(JsonMapper jsonMapper, ContractSchemas schemas, ToolResults results) {
        McpJsonMapper mcpJson = new JacksonMcpJsonMapper(jsonMapper);
        SyncToolSpecification targets = SyncToolSpecification.builder()
            .tool(McpSchema.Tool.builder("targets", mcpJson, schemas.inputSchema("targets"))
                .description("List target IDs, revisions, capabilities, path policy and limits before submitting.")
                .meta(TARGETS_TOOL_META)
                .annotations(new McpSchema.ToolAnnotations(null, true, false, true, null, null)).build())
            .callHandler((exchange, request) -> results.of(ContractEnvelope.success(new ContractEnvelope.TargetsData(List.of(), null,
                new ContractEnvelope.Limits(32768, 16384, 67108864, 262144, 16384, 60000), new ContractEnvelope.Approval("http://127.0.0.1:39125", false)))))
            .build();
        SyncToolSpecification submit = SyncToolSpecification.builder()
            .tool(McpSchema.Tool.builder("submit", mcpJson, schemas.inputSchema("submit"))
                .description("Submit command, Python source, or download with a stable operationKey and exact target revision.").build())
            .callHandler((exchange, request) -> results.of(ContractEnvelope.success(Map.of("received", request.arguments()))))
            .build();
        return List.of(targets, submit);
    }

    // A @Bean factory for the same reason: SyncResourceSpecification is a library type.
    @Bean
    List<SyncResourceSpecification> spikeResources() {
        McpSchema.Resource card = McpSchema.Resource.builder(CARD_URI, "SSH approval card").mimeType(CARD_MIME_TYPE).build();
        return List.of(new SyncResourceSpecification(card, (exchange, request) -> McpSchema.ReadResourceResult.builder(
            List.of(McpSchema.TextResourceContents.builder(CARD_URI, CARD_HTML).mimeType(CARD_MIME_TYPE).meta(CARD_CONTENT_META).build())).build()));
    }
}
