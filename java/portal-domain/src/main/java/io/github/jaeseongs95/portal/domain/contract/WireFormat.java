package io.github.jaeseongs95.portal.domain.contract;

import java.util.Objects;
import java.util.regex.Pattern;

/**
 * The string formats the public contract fixes (public-contract.mjs:7-12, 50, 214-216, 224, and the {@code pattern} of every baseline {@code outputSchema}). Each
 * constant owns one compiled pattern and judges a value against it, so the contract records state "this component is a digest" and the regular expression
 * exists once. The whole value must match: the patterns that end in {@code $} cannot accept a trailing line break, because {@link java.util.regex.Matcher#matches()}
 * has to consume the entire input.
 *
 * <p>It is package-private on purpose: the records of this package use it to refuse an invalid value at construction, and nothing else needs to know how.
 */
enum WireFormat {
    /** A 48 digit lower-case hex id of an operation, an output or an artifact ({@code identifier}). */
    IDENTIFIER("^[a-f0-9]{48}$"),
    /** A 64 digit lower-case hex SHA-256 value or target revision ({@code digest}). */
    DIGEST("^[a-f0-9]{64}$"),
    /** A target id ({@code target}). */
    TARGET("^[a-z][a-z0-9_-]{0,31}$"),
    /** An operation key ({@code key}); the end assertion also rejects a final CR or LF. */
    KEY("^[A-Za-z0-9_.:-]{16,128}(?![\\s\\S])"),
    /** A version 4 UUID of a staged file ({@code uuid}). */
    UUID("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\\s\\S])"),
    /** The key of a desktop open request ({@code openRequestKey}). */
    OPEN_REQUEST_KEY("^[a-f0-9]{32}_[0-9]{1,16}_[a-f0-9]{32}_[A-Za-z0-9_-]{43}(?![\\s\\S])"),
    /** A desktop session id: the baseline's {@code sessionId} (a UUID of version 1 to 8, or the nil and max UUIDs). */
    SESSION_ID("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
        + "|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"),
    /** The reference of a desktop session inside the readiness object ({@code sessionRef}). */
    SESSION_REF("^[A-Za-z0-9_.:-]{1,256}(?![\\s\\S])"),
    /** The name of the signal that ended a process ({@code execution.signal}). */
    SIGNAL("^[A-Z0-9_-]{1,32}$");

    private final Pattern pattern;

    WireFormat(String regex) {
        this.pattern = Pattern.compile(regex);
    }

    /** The regular expression text, as the baseline spells it. */
    String pattern() {
        return pattern.pattern();
    }

    /** Refuses a value that is null or does not match as a whole. */
    void require(String value, String field) {
        Objects.requireNonNull(value, field);
        if (!pattern.matcher(value).matches()) {
            throw new IllegalArgumentException(field + " does not match the contract format " + name());
        }
    }

    /** Like {@link #require} but a null value is the wire null and passes. */
    void requireOrNull(String value, String field) {
        if (value != null) {
            require(value, field);
        }
    }
}
