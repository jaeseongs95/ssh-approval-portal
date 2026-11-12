package io.github.jaeseongs95.portal.archchecks.fixtures.cycle.beta;

import io.github.jaeseongs95.portal.archchecks.fixtures.cycle.alpha.AlphaPart;

/** Breaks A-CYCLE on purpose, the other half of the pair: beta uses alpha, which uses beta (RuleFixturesTest.a_cycle). */
public final class BetaPart {

    public String label() {
        return "beta";
    }

    public String back() {
        return new AlphaPart().name();
    }
}
