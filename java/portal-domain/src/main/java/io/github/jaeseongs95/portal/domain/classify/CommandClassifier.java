package io.github.jaeseongs95.portal.domain.classify;

import io.github.jaeseongs95.portal.domain.text.CommandText;

/** Decides the {@link CommandClass} of a command line. The consumers (approval policy, request validation) depend on this interface, not on a rule set. */
public interface CommandClassifier {

    /**
     * Classifies a valid command text. The result is the vendor classification only: the 2.x rule that a multi-line command never stays {@code read-only}
     * is {@link CommandClassification#forMultiline(CommandText)}, which the caller applies.
     */
    CommandClassification classify(CommandText command);
}
