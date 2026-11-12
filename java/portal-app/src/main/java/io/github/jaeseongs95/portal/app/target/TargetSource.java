package io.github.jaeseongs95.portal.app.target;

import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.TargetLookup;

/**
 * Where the use cases read the administrator's targets from, as they stand now. The answer carries the revision, so a use case that held a revision when it started
 * compares it again before it acts (stage 3 design 3.5 point 8). The implementation reads the configuration of stage 4; stage 3 tests use a plain class.
 */
public interface TargetSource {

    /** The target with the id: found and enabled, not registered, or registered and switched off. */
    TargetLookup lookup(TargetId id);
}
