package io.github.jaeseongs95.portal.archchecks.fixtures.cycle.gamma;

import io.github.jaeseongs95.portal.archchecks.fixtures.cycle.alpha.AlphaPart;

/** The allowed form for A-CYCLE: gamma uses alpha, nothing uses gamma, so gamma is on no cycle and must not be named by the rule. */
public final class GammaUser {

    public String use() {
        return new AlphaPart().name();
    }
}
