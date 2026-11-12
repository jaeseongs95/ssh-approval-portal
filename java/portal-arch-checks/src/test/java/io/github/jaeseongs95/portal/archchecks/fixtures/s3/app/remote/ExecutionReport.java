package io.github.jaeseongs95.portal.archchecks.fixtures.s3.app.remote;

/** An outcome record: not an interface, so A-REMOTE-RESULT lets it through (stands for portal-app's ExecutionReport). */
public record ExecutionReport(String outcome) {
}
