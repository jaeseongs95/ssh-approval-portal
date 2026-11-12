package io.github.jaeseongs95.portal.domain.command;

import java.util.Objects;

/**
 * Everything an evaluator may know about a request besides the command itself, in three parts that are never mixed: what the caller says
 * ({@link CallerContext}, a claim), what the server states ({@link ServerFacts}, observed) and the submitted source ({@link SourceEvidence}, exact bytes). A
 * fact inside the caller's text stays a claim and never becomes a server fact (execution-context.mjs:47-67).
 */
public record ExecutionContext(CallerContext caller, ServerFacts serverFacts, SourceEvidence source) {

    public ExecutionContext {
        Objects.requireNonNull(caller, "caller");
        Objects.requireNonNull(serverFacts, "serverFacts");
        Objects.requireNonNull(source, "source");
    }
}
