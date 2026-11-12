package io.github.jaeseongs95.portal.domain.command;

import com.fasterxml.jackson.annotation.JsonValue;

/** The contract under which submitted source code may run on a target: none, or the Python source contract (command-policy.mjs:55 {@code sourceExecutionContract}). */
public enum SourceContract {
    NONE("none"),
    PYTHON_SOURCE_V1("python-source-v1");

    private final String wire;

    SourceContract(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
