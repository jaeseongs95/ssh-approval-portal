package io.github.jaeseongs95.portal.domain.command;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * The guidance shown to the owner before a command name is registered: what each known name is for and the care it calls for. The data is the file
 * {@code risk/command-risks.json}, copied unchanged from 2.x; the adapter that reads it builds this value. It grants no authority ({@link AuthorityEffect}),
 * it does not score arguments, and {@code sudo} is excluded because it has its own switch.
 */
public record CommandRiskCatalog(String schemaVersion, String purpose, AuthorityEffect authorityEffect, String argumentScope, List<String> excludedCommands,
                                 DefaultRisk defaultRisk, List<String> defaultCommands, Map<String, RiskEntry> commands) {

    public CommandRiskCatalog {
        Objects.requireNonNull(schemaVersion, "schemaVersion");
        Objects.requireNonNull(purpose, "purpose");
        Objects.requireNonNull(authorityEffect, "authorityEffect");
        Objects.requireNonNull(argumentScope, "argumentScope");
        Objects.requireNonNull(defaultRisk, "defaultRisk");
        excludedCommands = List.copyOf(excludedCommands);
        defaultCommands = List.copyOf(defaultCommands);
        commands = Collections.unmodifiableMap(new LinkedHashMap<>(commands));
        for (String name : defaultCommands) {
            if (!commands.containsKey(name)) {
                throw new IllegalArgumentException("A default command has an entry in the catalogue: " + name);
            }
        }
        for (String name : excludedCommands) {
            if (commands.containsKey(name)) {
                throw new IllegalArgumentException("An excluded command has no entry in the catalogue: " + name);
            }
        }
    }

    /** What the catalogue says about a name: its entry, or the default for a name it does not list. */
    public RiskDescription describe(String name) {
        RiskEntry entry = commands.get(name);
        return entry == null ? new RiskDescription.Unknown(defaultRisk) : new RiskDescription.Known(entry);
    }
}
