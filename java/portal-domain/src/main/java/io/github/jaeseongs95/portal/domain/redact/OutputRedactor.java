package io.github.jaeseongs95.portal.domain.redact;

/** Removes secrets from the output of a command. The consumers (output store, audit record) depend on this interface, not on a rule set. */
public interface OutputRedactor {

    /** The text with every secret it contains replaced; the text itself when it has none. */
    RedactedText redact(String raw);
}
