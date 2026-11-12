package io.github.jaeseongs95.portal.ssh.session;

import io.github.jaeseongs95.portal.app.remote.SshCredential;
import io.github.jaeseongs95.portal.domain.target.ConnectionProfile;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import java.util.Objects;

/**
 * One server of a connection: a jump host or the target, with the profile it is reached by and the credential that profile logs in with. The credential prints
 * without its secrets ({@link SshCredential}).
 */
public record Hop(ProfileAlias alias, ConnectionProfile profile, SshCredential credential) {
    public Hop {
        Objects.requireNonNull(alias, "alias");
        Objects.requireNonNull(profile, "profile");
        Objects.requireNonNull(credential, "credential");
    }
}
