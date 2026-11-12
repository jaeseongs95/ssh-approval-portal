package io.github.jaeseongs95.portal.ssh.session;

import io.github.jaeseongs95.portal.app.remote.CredentialLookup;
import io.github.jaeseongs95.portal.app.remote.ProfileLookup;
import io.github.jaeseongs95.portal.app.remote.ProfileSource;
import io.github.jaeseongs95.portal.app.remote.SshCredential;
import io.github.jaeseongs95.portal.app.remote.SshCredentialSource;
import io.github.jaeseongs95.portal.domain.target.ConnectionProfile;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.Setting;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.LinkedHashSet;
import java.util.Set;
import org.springframework.stereotype.Component;

/**
 * Follows the {@code via} of a connection profile to its jump hosts (stage 3 design 3.6, 2.x CR-03 and CR-05) and asks the credential source for the credential of every
 * server of the chain. It knows the profiles and credentials only through the two ports; making the connection is {@link SessionConnector}'s business. A profile whose
 * credential is the SSH agent is refused here ({@link ConnectFailureCause#AGENT_UNSUPPORTED}), before anything is connected.
 *
 * <p><b>Why MINA's own chain.</b> The chain of {@code HostConfigEntry.setProxyJump} is used (stage 3 pilot P3-5) because it lets the host key be checked hop by hop: for every session,
 * jump or target, {@code AbstractClientSession.checkKeys} gives the verifier the address of the server that session is for (the {@code TARGET_SERVER} attribute that
 * {@code SshClient.doConnect} sets on the target session), so each hop is checked against its own pin or record. The loopback listener that the chain opens
 * ({@code createLocalPortForwardingTracker(127.0.0.1:0)} in {@code SshClient.doConnect}) is not a difference between the chain and an explicit forwarding: both open it, so it
 * is not a reason to choose either.
 */
@Component
public final class ProxyJumpResolver {

    /** MINA's own limit for a chain ({@code CoreModuleProperties.MAX_PROXY_JUMPS}); the same number here so the adapter refuses a loop before MINA does. */
    static final int MAX_HOPS = 10;

    private final ProfileSource profiles;
    private final SshCredentialSource credentials;

    public ProxyJumpResolver(ProfileSource profiles, SshCredentialSource credentials) {
        this.profiles = profiles;
        this.credentials = credentials;
    }

    /** The servers of the connection for the profile, jump hosts first. */
    public JumpResolution resolve(ProfileAlias target) {
        Deque<Hop> chain = new ArrayDeque<>();
        Set<ProfileAlias> seen = new LinkedHashSet<>();
        ProfileAlias current = target;
        while (true) {
            if (!seen.add(current) || seen.size() > MAX_HOPS) {
                return failed(ConnectFailureCause.PROFILE_LOOP, current);
            }
            ProfileLookup lookup = profiles.lookup(current);
            if (!(lookup instanceof ProfileLookup.Found found)) {
                return failed(ConnectFailureCause.PROFILE_NOT_CONFIGURED, current);
            }
            ConnectionProfile profile = found.profile();
            CredentialLookup credential = credentials.resolve(current, profile);
            if (credential instanceof CredentialLookup.Missing) {
                return failed(ConnectFailureCause.CREDENTIAL_MISSING, current);
            }
            if (!(credential instanceof CredentialLookup.Resolved resolved)) {
                return failed(ConnectFailureCause.CREDENTIAL_UNSUPPORTED, current);
            }
            if (resolved.credential() instanceof SshCredential.Agent) {
                return failed(ConnectFailureCause.AGENT_UNSUPPORTED, current);
            }
            chain.addFirst(new Hop(current, profile, resolved.credential()));
            if (profile.via() instanceof Setting.Given<ProfileAlias> via) {
                current = via.value();
            } else {
                return new JumpResolution.Resolved(chain.stream().toList());
            }
        }
    }

    private JumpResolution failed(ConnectFailureCause cause, ProfileAlias hop) {
        return new JumpResolution.Failed(new ConnectFailure(cause, hop));
    }
}
