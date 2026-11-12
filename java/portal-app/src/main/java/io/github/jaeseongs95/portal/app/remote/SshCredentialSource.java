package io.github.jaeseongs95.portal.app.remote;

import io.github.jaeseongs95.portal.domain.target.ConnectionProfile;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;

/**
 * Where the credentials come from (2.x: {@code SSH_MCP_*} variables, read from the Spring {@code Environment} in 3.0). The profile name is an argument because a
 * source that reads by name needs it and the profile does not hold its own name.
 */
public interface SshCredentialSource {

    CredentialLookup resolve(ProfileAlias alias, ConnectionProfile profile);
}
