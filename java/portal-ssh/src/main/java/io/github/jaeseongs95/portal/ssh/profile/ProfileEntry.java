package io.github.jaeseongs95.portal.ssh.profile;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.target.ConnectionProfile;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;

/**
 * One profile of the file: its name, how to connect to it, and what else the file says about it.
 *
 * @param alias the name of the profile
 * @param connection how to connect: address, user, pinned host key, jump host, authentication, key reference, working directory, access and terminal
 * @param options the other values of the profile, with the defaults merged in
 */
public record ProfileEntry(ProfileAlias alias, ConnectionProfile connection, ProfileOptions options) {

    public ProfileEntry {
        Objects.requireNonNull(alias, "alias");
        Objects.requireNonNull(connection, "connection");
        Objects.requireNonNull(options, "options");
    }
}
