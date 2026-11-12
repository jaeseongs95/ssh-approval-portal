package io.github.jaeseongs95.portal.domain.redact;

/** One step of the redaction: a text in, the text with what this step finds replaced out. The steps run in order, each on the result of the one before. */
interface RedactionRule {

    String apply(String text);
}
