package io.github.jaeseongs95.portal.domain.file;

import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import java.util.Objects;

/**
 * Binds a file operation to the target and the target revision the server chose for it. The two values belong together: a binding with only one of them cannot be
 * built, so a partial binding is never silently read as "no binding" (2.x file-target-binding.mjs:2-8, case A-801). A file operation without a binding is a
 * {@link FileBinding.Unbound}.
 */
public record FileTargetBinding(TargetId targetId, TargetRevision targetRevision) {

    public FileTargetBinding {
        Objects.requireNonNull(targetId, "targetId");
        Objects.requireNonNull(targetRevision, "targetRevision");
    }
}
