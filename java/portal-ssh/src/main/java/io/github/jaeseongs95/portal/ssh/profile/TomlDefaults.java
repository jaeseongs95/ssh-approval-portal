package io.github.jaeseongs95.portal.ssh.profile;

import java.time.Duration;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.target.Setting;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Pattern;

/**
 * The {@code [defaults]} table of the profile file as it is written (2.x vendor config/schema.js:86-137): every key is optional and a missing key is {@code null}; the
 * defaults are applied after the validation by {@link #normalized()}. The numbers are {@code Long} so that a TOML integer of 64 bits is read whole and a text or a float is
 * refused, never converted. The bounds are those of the vendor schema. An unknown key is refused by the reader (PF-08).
 */
record TomlDefaults(
    String defaultProfile,
    @Min(1) Long sessionMaxPerConnection,
    @Min(1) Long sessionIdleTimeoutMs,
    @Min(1) Long sessionBackgroundMaxMs,
    @Min(1) Long commandTimeoutMs,
    @Min(0) Long commandMaxChars,
    @Min(1) Long commandMaxOutputBytes,
    @Min(1) Long connectionIdleReapMs,
    @Min(0) Long commandQuotaPerDay,
    @Min(0) Long approvalGrantTtlMs,
    @Pattern(regexp = TomlDefaults.APPROVAL_MODES, message = "must be one of auto, ask-destructive, ask-all, deny") String approvalMode,
    String transferRoot,
    @Min(1) @Max(TomlDefaults.MAX_SAFE_INTEGER) Long transferMaxBytes,
    @Min(1) @Max(TomlDefaults.MAX_TIMER_MS) Long transferTimeoutMs) {

    /** The largest integer a JavaScript number holds exactly (2.x {@code Number.MAX_SAFE_INTEGER}); the unlimited length of a command is this value. */
    static final long MAX_SAFE_INTEGER = ProfileDefaults.UNLIMITED_CHARS;
    /** The largest delay of a timer in 2.x, which is the largest 32-bit signed integer. */
    static final long MAX_TIMER_MS = 2_147_483_647L;
    static final String APPROVAL_MODES = "auto|ask-destructive|ask-all|deny";

    /** The defaults of a file whose {@code [defaults]} table is missing or empty (2.x {@code defaultsSchema.prefault({})}). */
    static TomlDefaults none() {
        return new TomlDefaults(null, null, null, null, null, null, null, null, null, null, null, null, null, null);
    }

    /** The table with every default applied (PF-10): a key that is there wins, also when it is 0 (2.x {@code ??}); a {@code commandMaxChars} of 0 is no limit (PF-23). */
    ProfileDefaults normalized() {
        long maxChars = Objects.requireNonNullElse(commandMaxChars, 5000L);
        return new ProfileDefaults(
            defaultProfile != null ? Setting.given(defaultProfile) : Setting.unset(),
            Objects.requireNonNullElse(sessionMaxPerConnection, 5L),
            Duration.ofMillis(Objects.requireNonNullElse(sessionIdleTimeoutMs, 600_000L)),
            Duration.ofMillis(Objects.requireNonNullElse(sessionBackgroundMaxMs, 3_600_000L)),
            Duration.ofMillis(Objects.requireNonNullElse(commandTimeoutMs, 60_000L)),
            maxChars == 0 ? ProfileDefaults.UNLIMITED_CHARS : maxChars,
            Objects.requireNonNullElse(commandMaxOutputBytes, 1_048_576L),
            Duration.ofMillis(Objects.requireNonNullElse(connectionIdleReapMs, 900_000L)),
            Objects.requireNonNullElse(commandQuotaPerDay, 0L),
            Duration.ofMillis(Objects.requireNonNullElse(approvalGrantTtlMs, 0L)),
            ProfileApproval.fromWire(Objects.requireNonNullElse(approvalMode, "ask-destructive")),
            transferRoot != null ? Setting.given(transferRoot) : Setting.unset(),
            Objects.requireNonNullElse(transferMaxBytes, 268_435_456L),
            Duration.ofMillis(Objects.requireNonNullElse(transferTimeoutMs, 300_000L)));
    }
}
