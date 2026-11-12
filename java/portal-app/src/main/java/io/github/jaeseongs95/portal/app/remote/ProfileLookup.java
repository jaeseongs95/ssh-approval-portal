package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.target.ConnectionProfile;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;

/** The answer to "which profile is this name": the profile, or none configured under that name. */
public sealed interface ProfileLookup permits ProfileLookup.Found, ProfileLookup.NotConfigured {

    /** The profile is configured. */
    record Found(ConnectionProfile profile) implements ProfileLookup {

        public Found {
            Objects.requireNonNull(profile, "profile");
        }
    }

    /** No profile has this name. */
    record NotConfigured(ProfileAlias alias) implements ProfileLookup {

        public NotConfigured {
            Objects.requireNonNull(alias, "alias");
        }
    }
}
