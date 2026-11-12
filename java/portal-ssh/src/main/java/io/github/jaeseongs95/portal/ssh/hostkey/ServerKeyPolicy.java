package io.github.jaeseongs95.portal.ssh.hostkey;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Path;
import java.util.Objects;

import org.apache.sshd.client.keyverifier.AcceptAllServerKeyVerifier;
import org.apache.sshd.client.keyverifier.RejectAllServerKeyVerifier;
import org.apache.sshd.client.keyverifier.ServerKeyVerifier;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.remote.SshSettings;
import io.github.jaeseongs95.portal.domain.target.ConnectionProfile;
import io.github.jaeseongs95.portal.domain.target.Setting;
import io.github.jaeseongs95.portal.ssh.profile.AccessVerdict;
import io.github.jaeseongs95.portal.ssh.profile.FileAccessGuard;
import io.github.jaeseongs95.portal.ssh.profile.ProfileConfigException;
import io.github.jaeseongs95.portal.ssh.profile.Protection;

/**
 * The host key policy of the SSH adapter (stage 3 design 3.6, decision D3-10): it gives the session code the MINA {@link ServerKeyVerifier} to use for a profile.
 *
 * <ul>
 * <li><b>A pinned key wins.</b> A profile with a {@code trustedHostKey} accepts only the key with that fingerprint, in every mode ({@link PinnedFingerprintVerifier},
 * CR-19). In {@code tofu} mode an accepted pinned key is also recorded when the host is not recorded yet.
 * <li><b>Without a pin the mode decides</b> ({@code SshSettings.hostKeyMode}): {@code tofu} (the default) records the first key of a host and refuses a different one later;
 * {@code strict} accepts only a host that is already recorded; {@code insecure} accepts every key and is kept for compatibility.
 * <li><b>The record is a {@code known_hosts} file</b> (OpenSSH's format, MINA's {@code DefaultKnownHostsServerKeyVerifier}), so a key that was trusted stays trusted after a
 * restart. 2.x kept the keys in memory and trusted again at every start. The file is created, with its folder, when it is missing, and only its owner can use it; an existing
 * file that other accounts may change is refused when the policy is built. A key that was refused changes nothing in the file.
 * <li><b>Reports.</b> A refused key is reported to {@link HostKeyEvents} with its code and fingerprints; the {@code insecure} mode is reported once, when this bean is built.
 * </ul>
 *
 * <p>One policy serves every profile: {@link #verifierFor} builds the small verifier of a profile, and all of them share the one record.
 */
@Component
public final class ServerKeyPolicy {

    private final HostKeyEvents events;
    private final RecordedKeyVerifier recorded;

    public ServerKeyPolicy(SshSettings settings, FileAccessGuard guard, HostKeyEvents events) {
        Objects.requireNonNull(settings, "settings");
        Objects.requireNonNull(guard, "guard");
        this.events = Objects.requireNonNull(events, "events");
        // The verifiers below are made with new, not as beans (Principles 3.1): they hold the settings of this one installation (the mode and the file) and the MINA classes
        // cannot carry an annotation; the policy is the one bean that owns them.
        this.recorded = switch (settings.hostKeyMode()) {
            case INSECURE -> {
                events.insecureModeActive();
                yield new RecordedKeyVerifier(settings.hostKeyMode(), AcceptAllServerKeyVerifier.INSTANCE, events);
            }
            case TOFU -> new RecordedKeyVerifier(settings.hostKeyMode(), new ObservingKnownHosts(AcceptAllServerKeyVerifier.INSTANCE, preparedFile(settings.knownHosts(), guard)), events);
            case STRICT -> new RecordedKeyVerifier(settings.hostKeyMode(), new ObservingKnownHosts(RejectAllServerKeyVerifier.INSTANCE, preparedFile(settings.knownHosts(), guard)), events);
        };
    }

    /**
     * The verifier for the connections of a profile: the pin of the profile when it has one, the mode of the installation otherwise. A pinned key that is blank is a
     * configuration error and is refused with an {@link IllegalArgumentException}.
     */
    public ServerKeyVerifier verifierFor(ConnectionProfile profile) {
        Objects.requireNonNull(profile, "profile");
        return switch (profile.pinnedHostKey()) {
            case Setting.Given<String> given -> new PinnedKeyVerifier(new PinnedFingerprintVerifier(given.value()), recorded, events);
            case Setting.Unset<String> unset -> recorded;
        };
    }

    /** Makes sure the file and its folder exist, private to the owner, and that nobody else may change what exists. */
    private Path preparedFile(Path file, FileAccessGuard guard) {
        try {
            guard.createPrivateFile(file);
            if (guard.inspect(file, Protection.NO_OTHER_WRITE) instanceof AccessVerdict.Refused refused) {
                throw new ProfileConfigException(ProfileConfigException.Code.KNOWN_HOSTS_UNSAFE, "The file of known hosts is not safe to trust: " + refused.reason());
            }
            return file;
        } catch (IOException e) {
            throw new UncheckedIOException("The file of known hosts " + file + " could not be prepared", e);
        }
    }
}
