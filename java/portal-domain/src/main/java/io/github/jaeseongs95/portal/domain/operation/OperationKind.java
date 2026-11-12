package io.github.jaeseongs95.portal.domain.operation;

import com.fasterxml.jackson.annotation.JsonValue;
import java.util.Locale;

/**
 * What an operation does. {@link #AGENT_CLI} (installing an agent command line tool for the owner) is not one of the four kinds the public contract shows
 * ({@code command}, {@code source}, {@code upload}, {@code download}); it exists so that one state machine and one execution queue serve every kind (decision D-11).
 */
public enum OperationKind {
    COMMAND, SOURCE, UPLOAD, DOWNLOAD, AGENT_CLI;

    @JsonValue
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }
}
