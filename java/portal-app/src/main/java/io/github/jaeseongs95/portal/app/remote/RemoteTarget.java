package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.AccessMode;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/**
 * Where a remote request goes and with which authority: the target, the revision the request was approved for, the connection profile that carries it and
 * whether that profile reads or writes. The use case resolves the profile name from the target ({@code readProfile} for {@link AccessMode#READ_ONLY},
 * {@code writeProfile} otherwise); the adapter looks it up in the {@link ProfileSource} and never maps a target to a profile itself.
 *
 * @param id the administrator's name of the target
 * @param revision the revision the operation is bound to; the {@link DispatchGuard} compares it with the current one before anything is sent
 * @param profile the connection profile to use
 * @param access what the profile may do
 */
public record RemoteTarget(TargetId id, TargetRevision revision, ProfileAlias profile, AccessMode access) {

    public RemoteTarget {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(revision, "revision");
        Objects.requireNonNull(profile, "profile");
        Objects.requireNonNull(access, "access");
    }
}
