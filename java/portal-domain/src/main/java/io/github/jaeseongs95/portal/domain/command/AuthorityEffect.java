package io.github.jaeseongs95.portal.domain.command;

import com.fasterxml.jackson.annotation.JsonValue;

/** What the risk catalogue grants. It grants nothing: it is guidance shown before a name is registered, never a permission to run (command-risks.json {@code authorityEffect}). */
public enum AuthorityEffect {
    NONE("none");

    private final String wire;

    AuthorityEffect(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
