package io.github.jaeseongs95.portal.web.spike;

import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/**
 * The one place that turns a contract envelope into an MCP tool result (Principles 3.8, "AgsToolResults" of the plan): structuredContent for hosts that read it and the
 * same JSON as text for hosts that read only {@code content}. One value, two renderings, so they cannot differ.
 */
@Component
class ToolResults {

    private final JsonMapper jsonMapper;

    ToolResults(JsonMapper jsonMapper) {
        this.jsonMapper = jsonMapper;
    }

    CallToolResult of(ContractEnvelope<?> envelope) {
        return CallToolResult.builder().structuredContent(envelope).addTextContent(jsonMapper.writeValueAsString(envelope)).build();
    }
}
