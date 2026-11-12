package io.github.jaeseongs95.portal.domain.file;

import io.github.jaeseongs95.portal.domain.id.CanonicalForm;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import java.util.Objects;

/**
 * The binding of a file operation to a target: none, or a complete {@link FileTargetBinding}. It stands where 2.x left both flat fields out, so an absent binding
 * is a value and not a null.
 */
public sealed interface FileBinding permits FileBinding.Unbound, FileBinding.Bound {

    /** Writes the binding into the canonical form of an operation contract: a marker for none, the target and its revision for a binding. */
    CanonicalForm describeTo(CanonicalForm form);

    /**
     * Reads the two flat fields the server keeps (the two database columns): both absent is {@link Unbound}, both valid is {@link Bound}, one without the other
     * or an invalid one is refused (2.x fileTargetBinding, case A-801). Absent is the Java null of the caller's column, the only place a null is read.
     */
    static FileBinding of(String targetId, String targetRevision) {
        if (targetId == null && targetRevision == null) {
            return new Unbound();
        }
        if (targetId == null || targetRevision == null) {
            throw new IllegalArgumentException("Invalid file target binding");
        }
        return new Bound(new FileTargetBinding(new TargetId(targetId), TargetRevision.of(targetRevision)));
    }

    /** The operation is not bound to a target. */
    record Unbound() implements FileBinding {

        @Override
        public CanonicalForm describeTo(CanonicalForm form) {
            return form.absent("file.binding");
        }
    }

    /** The operation is bound to a target and its revision. */
    record Bound(FileTargetBinding binding) implements FileBinding {

        public Bound {
            Objects.requireNonNull(binding, "binding");
        }

        @Override
        public CanonicalForm describeTo(CanonicalForm form) {
            return form.field("file.targetId", binding.targetId().value()).field("file.targetRevision", binding.targetRevision().hex());
        }
    }
}
