package io.github.jaeseongs95.portal.archchecks.fixtures.cycle.alpha;

import io.github.jaeseongs95.portal.archchecks.fixtures.cycle.beta.BetaPart;

/** Breaks A-CYCLE on purpose: alpha uses beta and beta uses alpha (RuleFixturesTest.a_cycle). */
public final class AlphaPart {

    public String name() {
        return "alpha:" + new BetaPart().label();
    }
}
