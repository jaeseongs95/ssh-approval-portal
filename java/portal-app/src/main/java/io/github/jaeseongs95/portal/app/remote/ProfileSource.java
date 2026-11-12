package io.github.jaeseongs95.portal.app.remote;

import io.github.jaeseongs95.portal.domain.target.ProfileAlias;

/** Where the connection profiles come from (2.x: the vendor TOML registry). The adapter asks by name for the profile of a request and for the jump profile of a profile. */
public interface ProfileSource {

    ProfileLookup lookup(ProfileAlias alias);
}
