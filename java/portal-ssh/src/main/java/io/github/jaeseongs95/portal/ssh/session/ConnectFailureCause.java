package io.github.jaeseongs95.portal.ssh.session;

/**
 * Why a session could not be made, as far as the adapter can tell (stage 3 design 3.2 P1, 3.5, 3.6). The owner reads {@link #ownerText()}, a fixed sentence: the text of an
 * exception, a host name or a credential never reaches the owner or a log through it.
 */
public enum ConnectFailureCause {
    /** The profile (or the jump profile it names) is not configured. */
    PROFILE_NOT_CONFIGURED("The connection profile of the target is not configured."),
    /** The profiles name each other as jump hosts, or the chain is longer than the limit. */
    PROFILE_LOOP("The jump hosts of the connection profile form a loop or a chain that is too long."),
    /** No source has the credential of a profile. */
    CREDENTIAL_MISSING("The credential of the connection profile is not available."),
    /** The authentication method of a profile is not supported here. */
    CREDENTIAL_UNSUPPORTED("The authentication method of the connection profile is not supported."),
    /**
     * The profile authenticates by the SSH agent. 2.x used the agent of the machine it ran on ({@code SSH_AUTH_SOCK} when {@code auth = "agent"}, vendor rule EV-08); this
     * adapter has no agent client, so the connection is refused before anything is sent, with this cause instead of a login that fails without a reason.
     */
    AGENT_UNSUPPORTED("The agent credential is not supported: the SSH agent cannot be used by this adapter."),
    /** The key the host presented was refused (a pin did not match, a recorded key changed, an unknown host under strict checking). */
    HOST_KEY_REFUSED("The host key of the target was refused."),
    /** The server was reached and refused the login, or the credential could not be used. */
    AUTHENTICATION_FAILED("The target refused the login."),
    /** The connection could not be made or did not finish in time. */
    UNREACHABLE("The target could not be reached.");

    private final String ownerText;

    ConnectFailureCause(String ownerText) {
        this.ownerText = ownerText;
    }

    /** A fixed sentence for the owner. */
    public String ownerText() {
        return ownerText;
    }
}
