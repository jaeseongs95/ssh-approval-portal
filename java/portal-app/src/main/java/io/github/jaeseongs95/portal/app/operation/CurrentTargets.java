package io.github.jaeseongs95.portal.app.operation;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.target.TargetSource;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;
import io.github.jaeseongs95.portal.domain.target.TargetLookup;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/**
 * Compares what a request holds with the target as it is now (stage 3 design 3.5 point 8, cases B-234, B-240): an operation is bound to the revision it was approved
 * for, so a target that changed since is refused with {@code TARGET_REVISION_CONFLICT} and the caller asks for the targets again.
 */
@Component
public class CurrentTargets {

    private final TargetSource targets;

    public CurrentTargets(TargetSource targets) {
        this.targets = targets;
    }

    /** The target if it is registered and enabled. @throws RequestRefusedException {@code TARGET_UNAVAILABLE} */
    public ResolvedTarget require(TargetId id) {
        return switch (targets.lookup(id)) {
            case TargetLookup.Found found -> found.target();
            case TargetLookup.NotRegistered notRegistered -> throw new RequestRefusedException(RequestErrorCode.TARGET_UNAVAILABLE);
            case TargetLookup.Disabled disabled -> throw new RequestRefusedException(RequestErrorCode.TARGET_UNAVAILABLE);
        };
    }

    /** The target if it is registered, enabled and still at the revision. @throws RequestRefusedException {@code TARGET_UNAVAILABLE} or {@code TARGET_REVISION_CONFLICT} */
    public ResolvedTarget requireAt(TargetId id, TargetRevision revision) {
        ResolvedTarget target = require(id);
        if (!target.revision().equals(revision)) {
            throw new RequestRefusedException(RequestErrorCode.TARGET_REVISION_CONFLICT);
        }
        return target;
    }
}
