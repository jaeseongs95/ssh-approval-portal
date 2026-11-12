package io.github.jaeseongs95.portal.archchecks.fixtures.s3.app.target;

import io.github.jaeseongs95.portal.archchecks.fixtures.s3.domain.target.TargetOs;

/** Stands for portal-app's TargetPlatform: an implementation names its own OS constant, which A-SSH-NO-PLATFORM-BRANCH allows. */
public interface TargetPlatform {
    TargetOs os();
}
