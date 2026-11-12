package io.github.jaeseongs95.portal.archchecks.fixtures.dir.domain;

import io.github.jaeseongs95.portal.archchecks.fixtures.dir.app.AppThing;

/** domain uses app: the forbidden direction (A-DIR), and a domain class depending on a non-JDK package (A-DOMAIN). */
public class BadDomain {
    public AppThing make() {
        return new AppThing();
    }
}
