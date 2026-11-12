package io.github.jaeseongs95.portal.ssh.profile;

import java.time.Duration;
import java.util.Locale;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.target.AccessMode;
import io.github.jaeseongs95.portal.domain.target.AuthMethod;
import io.github.jaeseongs95.portal.domain.target.ConnectionProfile;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.Setting;
import io.github.jaeseongs95.portal.domain.target.TtyMode;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * One {@code [[profiles]]} table as it is written (2.x vendor config/schema.js:138-187). {@code name}, {@code host} and {@code user} are required; every other key is
 * optional and a missing key is {@code null} until the defaults are applied. Booleans are TOML booleans (the text {@code "true"} is refused) and numbers are TOML
 * integers. An unknown key is refused by the reader (PF-08). The table knows how to become the entry of the catalog: {@link #entry(ProfileDefaults)}.
 */
record TomlProfile(
    @NotNull(message = "is required") @Size(min = 1, message = "must not be empty") String name,
    @NotNull(message = "is required") @Size(min = 1, message = "must not be empty") String host,
    @Min(1) @Max(65535) Long port,
    @NotNull(message = "is required") @Size(min = 1, message = "must not be empty") String user,
    @Pattern(regexp = "agent|key|password|keychain", message = "must be one of agent, key, password, keychain") String auth,
    String keyRef,
    String keychainEntry,
    String via,
    String group,
    String workdir,
    @Pattern(regexp = "(?s)\\s*\\S.*", message = "trustedHostKey cannot be empty") String trustedHostKey,
    Boolean tty,
    String role,
    Boolean readOnly,
    Boolean cert,
    Boolean announceAgent,
    @Min(1) Long timeout,
    @Min(0) Long maxChars,
    @Min(1) Long maxOutputBytes,
    @Pattern(regexp = TomlDefaults.APPROVAL_MODES, message = "must be one of auto, ask-destructive, ask-all, deny") String approvalPolicy,
    @Min(1) Long sessionMaxPerConnection,
    @Min(1) Long sessionIdleTimeoutMs,
    @Min(1) Long sessionBackgroundMaxMs,
    @Min(0) Long commandQuotaPerDay,
    @Min(1) @Max(TomlDefaults.MAX_SAFE_INTEGER) Long transferMaxBytes,
    @Min(1) @Max(TomlDefaults.MAX_TIMER_MS) Long transferTimeoutMs) {

    /**
     * The entry of this profile: its name, how to connect, and its other values with the defaults merged in.
     *
     * @throws IllegalArgumentException when the name, the jump profile name or the connection is not valid for the domain types (stricter than the vendor schema)
     */
    ProfileEntry entry(ProfileDefaults defaults) {
        return new ProfileEntry(new ProfileAlias(name), connection(), optionsOver(defaults));
    }

    private ConnectionProfile connection() {
        return new ConnectionProfile(
            host,
            port != null ? Math.toIntExact(port) : 22,
            user,
            trustedHostKey != null ? Setting.given(trustedHostKey.strip()) : Setting.unset(),
            via != null ? Setting.given(new ProfileAlias(via)) : Setting.unset(),
            auth != null ? AuthMethod.valueOf(auth.toUpperCase(Locale.ROOT)) : AuthMethod.AGENT,
            keyRef != null ? Setting.given(keyRef) : Setting.unset(),
            workdir != null ? Setting.given(workdir) : Setting.unset(),
            Boolean.TRUE.equals(readOnly) ? AccessMode.READ_ONLY : AccessMode.READ_WRITE,
            Boolean.TRUE.equals(tty) ? TtyMode.TTY : TtyMode.NO_TTY);
    }

    /**
     * The values of the profile besides the connection, with the defaults merged in: a value of the profile wins, also when it is 0, and a key it leaves out takes the value
     * of {@code [defaults]} (2.x vendor config/loader.js:162-173, PF-13 to PF-22). The length limit 0 is no limit (PF-23); the daily quota 0 stays 0.
     */
    private ProfileOptions optionsOver(ProfileDefaults defaults) {
        return new ProfileOptions(
            group != null ? Setting.given(group) : Setting.unset(),
            Objects.requireNonNullElse(role, "operator"),
            announceAgent == null || announceAgent,
            Boolean.TRUE.equals(cert),
            keychainEntry != null ? Setting.given(keychainEntry) : Setting.unset(),
            timeout != null ? Duration.ofMillis(timeout) : defaults.commandTimeout(),
            maxChars == null ? defaults.commandMaxChars() : maxChars == 0 ? ProfileDefaults.UNLIMITED_CHARS : maxChars,
            Objects.requireNonNullElse(maxOutputBytes, defaults.commandMaxOutputBytes()),
            approvalPolicy != null ? ProfileApproval.fromWire(approvalPolicy) : defaults.approval(),
            Objects.requireNonNullElse(sessionMaxPerConnection, defaults.sessionMaxPerConnection()),
            sessionIdleTimeoutMs != null ? Duration.ofMillis(sessionIdleTimeoutMs) : defaults.sessionIdleTimeout(),
            sessionBackgroundMaxMs != null ? Duration.ofMillis(sessionBackgroundMaxMs) : defaults.sessionBackgroundMax(),
            Objects.requireNonNullElse(commandQuotaPerDay, defaults.commandQuotaPerDay()),
            Objects.requireNonNullElse(transferMaxBytes, defaults.transferMaxBytes()),
            transferTimeoutMs != null ? Duration.ofMillis(transferTimeoutMs) : defaults.transferTimeout());
    }
}
