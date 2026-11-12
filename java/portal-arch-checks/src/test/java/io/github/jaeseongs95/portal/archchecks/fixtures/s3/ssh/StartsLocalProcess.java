package io.github.jaeseongs95.portal.archchecks.fixtures.s3.ssh;

import java.io.IOException;

// Break A-NO-LOCAL-PROCESS on purpose: a portal-ssh class that starts a local process instead of opening an SSH channel (RuleFixturesTest.a_noLocalProcess).

final class StartsLocalProcess {
    Object run() {
        return new ProcessBuilder("x");
    }
}

final class ExecsLocalRuntime {
    Object run() throws IOException {
        return Runtime.getRuntime().exec(new String[] {"x"});
    }
}
