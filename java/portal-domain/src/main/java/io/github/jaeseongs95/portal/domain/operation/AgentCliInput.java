package io.github.jaeseongs95.portal.domain.operation;

import io.github.jaeseongs95.portal.domain.id.CanonicalForm;
import io.github.jaeseongs95.portal.domain.id.Digest;
import java.util.Objects;

/** The installation of an agent command line tool. The details (provider, release, intent) are kept with the install request; the operation holds the digest that names them. */
public record AgentCliInput(Digest intentDigest) implements OperationInput {

    public AgentCliInput {
        Objects.requireNonNull(intentDigest, "intentDigest");
    }

    @Override
    public OperationKind kind() {
        return OperationKind.AGENT_CLI;
    }

    @Override
    public CanonicalForm describeTo(CanonicalForm form) {
        return form.field("input.kind", "agent_cli").field("agentCli.intentDigest", intentDigest.hex());
    }
}
