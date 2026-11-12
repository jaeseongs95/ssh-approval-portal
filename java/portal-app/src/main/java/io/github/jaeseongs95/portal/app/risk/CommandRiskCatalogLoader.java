package io.github.jaeseongs95.portal.app.risk;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;

import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.domain.command.CommandRiskCatalog;
import tools.jackson.databind.json.JsonMapper;

/**
 * Reads the command risk catalog ({@code risk/command-risks.json}, bytes identical to 2.x) from the resource of portal-domain. The domain cannot parse JSON
 * (rule A-DOMAIN), so this module binds the file to the domain record with the Boot {@link JsonMapper}; the record's component names are the file's keys. The file is
 * read once at start-up: a damaged resource stops the application.
 */
@Component
public class CommandRiskCatalogLoader {

    static final String RESOURCE = "risk/command-risks.json";

    private final CommandRiskCatalog catalog;

    public CommandRiskCatalogLoader(JsonMapper mapper) {
        try (InputStream in = new ClassPathResource(RESOURCE).getInputStream()) {
            this.catalog = mapper.readValue(in, CommandRiskCatalog.class);
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot read the resource " + RESOURCE, e);
        }
    }

    public CommandRiskCatalog catalog() {
        return catalog;
    }
}
