package io.github.jaeseongs95.portal.domain.operation;

import io.github.jaeseongs95.portal.domain.id.CanonicalForm;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import java.util.Objects;

/**
 * What a caller asks to be accepted as an operation. The contract digest is part of it: two requests with the same key are the same operation exactly when their
 * digests are equal, and different ones are a key conflict (2.x operation-store.mjs:170-174). The digest covers the owner, the target and its revision, the
 * profile, the kind and input, the conflict key and the deadline the caller <em>asked for</em>. It does not cover the moment of the request or the deadline that
 * moment resolves to, or a retry a minute later would conflict with itself.
 *
 * @param requestKey the key that makes the request repeatable
 * @param owner who owns the operation
 * @param targetId the target
 * @param targetRevision the revision of the target the operation is approved for
 * @param profile the connection profile the operation uses
 * @param input what to do
 * @param conflictKey the resource it fences
 * @param requestedExpiry the deadline the caller asked for, or none for the default hour
 * @param contractDigest the digest of the immutable fields
 */
public record NewOperation(RequestKey requestKey, OwnerId owner, TargetId targetId, TargetRevision targetRevision, ProfileAlias profile, OperationInput input,
                           ConflictKey conflictKey, Deadline requestedExpiry, Digest contractDigest) {

    public NewOperation {
        Objects.requireNonNull(requestKey, "requestKey");
        Objects.requireNonNull(owner, "owner");
        Objects.requireNonNull(targetId, "targetId");
        Objects.requireNonNull(targetRevision, "targetRevision");
        Objects.requireNonNull(profile, "profile");
        Objects.requireNonNull(input, "input");
        Objects.requireNonNull(conflictKey, "conflictKey");
        Objects.requireNonNull(requestedExpiry, "requestedExpiry");
        Objects.requireNonNull(contractDigest, "contractDigest");
    }

    /** The request with its contract digest taken by the digester. */
    public static NewOperation of(Digester digester, RequestKey requestKey, OwnerId owner, TargetId targetId, TargetRevision targetRevision, ProfileAlias profile,
                                  OperationInput input, ConflictKey conflictKey, Deadline requestedExpiry) {
        Objects.requireNonNull(digester, "digester");
        Objects.requireNonNull(owner, "owner");
        Objects.requireNonNull(targetId, "targetId");
        Objects.requireNonNull(targetRevision, "targetRevision");
        Objects.requireNonNull(profile, "profile");
        Objects.requireNonNull(input, "input");
        Objects.requireNonNull(conflictKey, "conflictKey");
        Objects.requireNonNull(requestedExpiry, "requestedExpiry");
        CanonicalForm form = new CanonicalForm().field("owner", owner.value()).field("targetId", targetId.value()).field("targetRevision", targetRevision.hex())
            .field("profile", profile.value()).field("kind", input.kind().name());
        input.describeTo(form);
        switch (conflictKey) {
            case ConflictKey.None none -> form.absent("conflictKey");
            case ConflictKey.Of of -> form.field("conflictKey", of.value());
        }
        switch (requestedExpiry) {
            case Deadline.None none -> form.absent("expiry");
            case Deadline.At at -> form.field("expiry", at.instant().toString());
        }
        return new NewOperation(requestKey, owner, targetId, targetRevision, profile, input, conflictKey, requestedExpiry, form.digest(digester));
    }

    /** The kind of operation, which is the kind of its input. */
    public OperationKind kind() {
        return input.kind();
    }
}
