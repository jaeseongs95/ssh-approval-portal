package io.github.jaeseongs95.portal.domain.target;

import io.github.jaeseongs95.portal.domain.id.CanonicalForm;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.util.Objects;

/**
 * How to reach a target by SSH: the address, the user, the key the host must present, an optional jump host, the way to authenticate, what the profile may do, and
 * whether it allocates a terminal. The credential itself is never here, only the name the secret is looked up by (a key reference); rotating a credential
 * therefore needs a new administrator revision of the target, not a new profile value (2.x targets.mjs:68-74).
 *
 * @param host the DNS name or address of the target, 1 to 253 characters
 * @param port the TCP port, 1 to 65535
 * @param user the account on the target, 1 to 256 characters
 * @param pinnedHostKey the host key the target has to present
 * @param via the profile of a jump host
 * @param auth how the profile authenticates
 * @param keyRef the name the credential is looked up by
 * @param workdir the working directory a POSIX profile starts commands in
 * @param access what the profile may do
 * @param tty whether a terminal is allocated
 */
public record ConnectionProfile(String host, int port, String user, Setting<String> pinnedHostKey, Setting<ProfileAlias> via, AuthMethod auth, Setting<String> keyRef,
                                Setting<String> workdir, AccessMode access, TtyMode tty) {

    public ConnectionProfile {
        Objects.requireNonNull(host, "host");
        Objects.requireNonNull(user, "user");
        Objects.requireNonNull(pinnedHostKey, "pinnedHostKey");
        Objects.requireNonNull(via, "via");
        Objects.requireNonNull(auth, "auth");
        Objects.requireNonNull(keyRef, "keyRef");
        Objects.requireNonNull(workdir, "workdir");
        Objects.requireNonNull(access, "access");
        Objects.requireNonNull(tty, "tty");
        if (host.isEmpty() || host.length() > 253 || new Utf8Text(host).hasHiddenCharacters() || port < 1 || port > 65535 || user.isEmpty() || user.length() > 256
            || new Utf8Text(user).hasHiddenCharacters()) {
            throw new IllegalArgumentException("A connection profile needs a host, a port from 1 to 65535 and a user");
        }
    }

    /** True when the profile's connection is the same as the other's: address, user, host key, jump host, authentication and key reference (access, terminal and working directory may differ). */
    public boolean sharesConnectionWith(ConnectionProfile other) {
        return host.equals(other.host) && port == other.port && user.equals(other.user) && pinnedHostKey.equals(other.pinnedHostKey) && via.equals(other.via)
            && auth == other.auth && keyRef.equals(other.keyRef);
    }

    /** Writes every field into a canonical form under the prefix, for the revision of the target. */
    CanonicalForm describeTo(CanonicalForm form, String prefix) {
        form.field(prefix + ".host", host).field(prefix + ".port", port).field(prefix + ".user", user);
        pinnedHostKey.describeTo(form, prefix + ".pinnedHostKey", key -> key);
        via.describeTo(form, prefix + ".via", ProfileAlias::value);
        form.field(prefix + ".auth", auth.name());
        keyRef.describeTo(form, prefix + ".keyRef", key -> key);
        workdir.describeTo(form, prefix + ".workdir", directory -> directory);
        return form.field(prefix + ".access", access.name()).field(prefix + ".tty", tty.name());
    }
}
