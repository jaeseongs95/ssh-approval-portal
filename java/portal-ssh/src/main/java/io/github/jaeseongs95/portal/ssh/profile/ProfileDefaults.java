package io.github.jaeseongs95.portal.ssh.profile;

import java.time.Duration;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.target.Setting;

/**
 * The {@code [defaults]} table with every default applied (2.x vendor config/schema.js:86-137, PF-10); {@code TomlDefaults.normalized()} makes it. A profile without a value
 * of its own takes the value here (PF-13 to PF-22); {@code defaultProfile}, {@code connectionIdleReap}, {@code approvalGrantTtl} and {@code transferRoot} are not copied to the
 * profiles and stay here (PF-24). {@code commandMaxChars} is {@link #UNLIMITED_CHARS} when the file says {@code 0} (PF-23).
 *
 * @param defaultProfile the profile that is selected when no name is given
 * @param sessionMaxPerConnection how many sessions a connection allows
 * @param sessionIdleTimeout how long a session may be idle
 * @param sessionBackgroundMax how long a background session may live
 * @param commandTimeout how long a command may take
 * @param commandMaxChars the longest command text, {@link #UNLIMITED_CHARS} for no limit
 * @param commandMaxOutputBytes the most output bytes that are kept
 * @param connectionIdleReap how long an idle connection stays open
 * @param commandQuotaPerDay how many commands a day, 0 for no limit
 * @param approvalGrantTtl how long an approval grant lasts, zero for none
 * @param approval the approval mode
 * @param transferRoot the folder transfers are limited to
 * @param transferMaxBytes the largest transfer in bytes
 * @param transferTimeout how long a transfer may be idle
 */
public record ProfileDefaults(Setting<String> defaultProfile, long sessionMaxPerConnection, Duration sessionIdleTimeout, Duration sessionBackgroundMax,
                              Duration commandTimeout, long commandMaxChars, long commandMaxOutputBytes, Duration connectionIdleReap, long commandQuotaPerDay,
                              Duration approvalGrantTtl, ProfileApproval approval, Setting<String> transferRoot, long transferMaxBytes, Duration transferTimeout) {

    /** 2.x {@code Number.MAX_SAFE_INTEGER}: what {@code commandMaxChars = 0} (no limit) becomes. */
    public static final long UNLIMITED_CHARS = 9_007_199_254_740_991L;

    public ProfileDefaults {
        Objects.requireNonNull(defaultProfile, "defaultProfile");
        Objects.requireNonNull(sessionIdleTimeout, "sessionIdleTimeout");
        Objects.requireNonNull(sessionBackgroundMax, "sessionBackgroundMax");
        Objects.requireNonNull(commandTimeout, "commandTimeout");
        Objects.requireNonNull(connectionIdleReap, "connectionIdleReap");
        Objects.requireNonNull(approvalGrantTtl, "approvalGrantTtl");
        Objects.requireNonNull(approval, "approval");
        Objects.requireNonNull(transferRoot, "transferRoot");
        Objects.requireNonNull(transferTimeout, "transferTimeout");
    }
}
