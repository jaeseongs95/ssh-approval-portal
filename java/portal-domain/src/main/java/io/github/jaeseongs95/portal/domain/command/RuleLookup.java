package io.github.jaeseongs95.portal.domain.command;

import java.util.Objects;

/** The answer to "what did the owner allow for this target": a rule, or no rule. With no rule nothing is pre-approved, so a request goes to the owner. */
public sealed interface RuleLookup permits RuleLookup.Rule, RuleLookup.NoRule {

    record Rule(TargetRule rule) implements RuleLookup {
        public Rule {
            Objects.requireNonNull(rule, "rule");
        }
    }

    record NoRule() implements RuleLookup {
    }
}
