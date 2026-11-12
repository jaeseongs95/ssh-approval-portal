package io.github.jaeseongs95.portal.domain.host;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.InputStream;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The vectors of the shared settings contract ({@code contract/settings/settings-contract.json}), read from the test classpath. The file is the one copy of the
 * truth for the administrator origin and the upload host rules; the build gives the domain tests the folder it lives in, so no copy is made here.
 */
public final class SettingsVectors {

    private static final String RESOURCE = "/contract/settings/settings-contract.json";

    private final JsonNode root;

    public SettingsVectors() throws IOException {
        try (InputStream in = SettingsVectors.class.getResourceAsStream(RESOURCE)) {
            assertThat(in).as("the shared settings vectors %s are on the test classpath", RESOURCE).isNotNull();
            this.root = new JsonMapper().readTree(in);
        }
    }

    public JsonNode originVectors() {
        return root.get("originVectors");
    }

    public JsonNode uploadHostVectors() {
        return root.get("uploadHostVectors");
    }

    public JsonNode uploadHostMatchVectors() {
        return root.get("uploadHostMatchVectors");
    }

    public int originMaxBytes() {
        return root.get("originMaxBytes").intValue();
    }
}
