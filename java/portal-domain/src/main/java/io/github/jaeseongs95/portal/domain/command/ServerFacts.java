package io.github.jaeseongs95.portal.domain.command;

import java.util.EnumMap;
import java.util.Map;

/**
 * The facts the server states about a request, kept apart from what the caller says: the caller cannot set them, and the evaluator is told they are observed by
 * the server while the caller's description is "not independently verified and never authorization" (execution-context.mjs:47-67).
 */
public record ServerFacts(Map<ServerFactKey, FactValue> values) {

    public ServerFacts {
        values = Map.copyOf(values);
    }

    /** No fact. */
    public static ServerFacts none() {
        return new ServerFacts(Map.of());
    }

    /**
     * Keeps the candidates whose name is on the whitelist and drops every other key, as 2.x does ({@code adminToken} and {@code apiKey} never reach the
     * evaluator). A name matches only exactly.
     */
    public static ServerFacts whitelisting(Map<String, FactValue> candidates) {
        Map<ServerFactKey, FactValue> kept = new EnumMap<>(ServerFactKey.class);
        for (ServerFactKey key : ServerFactKey.values()) {
            FactValue value = candidates.get(key.wire());
            if (value != null) {
                kept.put(key, value);
            }
        }
        return new ServerFacts(kept);
    }
}
