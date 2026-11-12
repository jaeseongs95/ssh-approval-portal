package io.github.jaeseongs95.portal.domain.agentcli;

import java.util.EnumSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * The providers the portal knows, in the order they were given. The list is injected (the application collects every {@link AgentCliProvider} bean), so the
 * catalog holds no provider names and a new provider needs no change here. It refuses a list with the same id twice and answers only for ids it holds.
 */
public final class AgentCliCatalog {

    private final List<AgentCliProvider> providers;

    public AgentCliCatalog(List<AgentCliProvider> providers) {
        Objects.requireNonNull(providers, "providers");
        List<AgentCliProvider> copy = List.copyOf(providers);
        if (copy.isEmpty()) {
            throw new IllegalArgumentException("The provider catalog is empty");
        }
        Set<AgentCliProviderId> seen = EnumSet.noneOf(AgentCliProviderId.class);
        for (AgentCliProvider provider : copy) {
            if (!seen.add(provider.id())) {
                throw new IllegalArgumentException("Two providers have the same id: " + provider.id().wire());
            }
        }
        this.providers = copy;
    }

    /** The providers in injection order; the list cannot be changed. */
    public List<AgentCliProvider> providers() {
        return providers;
    }

    public AgentCliProvider provider(AgentCliProviderId id) {
        Objects.requireNonNull(id, "id");
        for (AgentCliProvider provider : providers) {
            if (provider.id() == id) {
                return provider;
            }
        }
        throw new IllegalArgumentException("Unsupported CLI provider");
    }
}
