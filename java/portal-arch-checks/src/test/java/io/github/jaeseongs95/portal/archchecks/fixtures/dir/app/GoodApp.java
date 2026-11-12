package io.github.jaeseongs95.portal.archchecks.fixtures.dir.app;

import io.github.jaeseongs95.portal.archchecks.fixtures.dir.domain.PureDomain;

/** app uses domain: the allowed direction, no rule may flag it. */
public class GoodApp {
    public PureDomain make() {
        return new PureDomain("x");
    }
}
