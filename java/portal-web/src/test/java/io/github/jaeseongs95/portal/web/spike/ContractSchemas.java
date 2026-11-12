package io.github.jaeseongs95.portal.web.spike;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

/** The JSON Schema text of a tool's input, moved from the Zod definition of src/adapters/mcp/public-contract.mjs (resources contract-spike/). */
@Component
class ContractSchemas {

    String inputSchema(String tool) {
        try {
            return new ClassPathResource("contract-spike/" + tool + ".input.schema.json").getContentAsString(StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("cannot read the contract schema of " + tool, e);
        }
    }
}
