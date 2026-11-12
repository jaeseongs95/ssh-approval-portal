package io.github.jaeseongs95.portal.app.risk;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.domain.command.CommandRiskCatalog;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;

class CommandRiskCatalogLoaderTest {

    // Boot's JsonMapper bean ignores unknown properties (the file has the keys schemaVersion, purpose, authorityEffect and argumentScope); the test mapper is set the same way.
    private final JsonMapper mapper = JsonMapper.builder().disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES).build();

    @Test
    @DisplayName("S2-RE-01: the loader reads the catalog of the domain resource: default commands, the excluded sudo and the known commands")
    void catalogIsRead() {
        CommandRiskCatalog catalog = new CommandRiskCatalogLoader(mapper).catalog();
        assertThat(catalog.defaultCommands()).contains("pwd", "ls", "hostname");
        assertThat(catalog.excludedCommands()).containsExactly("sudo");
        assertThat(catalog.commands()).containsKeys("pwd", "ls", "stat");
    }
}
