package io.github.jaeseongs95.portal.ssh.profile;

import java.time.Duration;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.target.Setting;

/**
 * What a profile of the file says besides how to connect (the connection is a {@code ConnectionProfile}), with the defaults merged in: a value of the profile wins, also
 * when it is 0, and a key it leaves out takes the value of {@code [defaults]} (2.x vendor config/loader.js:162-173, PF-13 to PF-22; the merge is {@code TomlProfile}'s). The
 * length limit 0 is {@link ProfileDefaults#UNLIMITED_CHARS} (PF-23); the daily quota 0 stays 0 (PF-23).
 *
 * @param group the group label
 * @param role the role, {@code operator} when the file has none
 * @param announceAgent whether the channel environment says which agent is acting; true when the file has no value
 * @param cert whether an OpenSSH certificate goes with the key
 * @param keychainEntry the system keychain entry of a keychain profile, which 3.0 does not use
 * @param commandTimeout how long a command may take
 * @param commandMaxChars the longest command text
 * @param commandMaxOutputBytes the most output bytes that are kept
 * @param approval the approval mode
 * @param sessionMaxPerConnection how many sessions a connection allows
 * @param sessionIdleTimeout how long a session may be idle
 * @param sessionBackgroundMax how long a background session may live
 * @param commandQuotaPerDay how many commands a day, 0 for no limit
 * @param transferMaxBytes the largest transfer in bytes
 * @param transferTimeout how long a transfer may be idle
 */
public record ProfileOptions(Setting<String> group, String role, boolean announceAgent, boolean cert, Setting<String> keychainEntry, Duration commandTimeout,
                             long commandMaxChars, long commandMaxOutputBytes, ProfileApproval approval, long sessionMaxPerConnection, Duration sessionIdleTimeout,
                             Duration sessionBackgroundMax, long commandQuotaPerDay, long transferMaxBytes, Duration transferTimeout) {

    public ProfileOptions {
        Objects.requireNonNull(group, "group");
        Objects.requireNonNull(role, "role");
        Objects.requireNonNull(keychainEntry, "keychainEntry");
        Objects.requireNonNull(commandTimeout, "commandTimeout");
        Objects.requireNonNull(approval, "approval");
        Objects.requireNonNull(sessionIdleTimeout, "sessionIdleTimeout");
        Objects.requireNonNull(sessionBackgroundMax, "sessionBackgroundMax");
        Objects.requireNonNull(transferTimeout, "transferTimeout");
    }
}
