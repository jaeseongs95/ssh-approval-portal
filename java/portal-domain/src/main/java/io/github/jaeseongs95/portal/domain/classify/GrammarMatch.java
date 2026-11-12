package io.github.jaeseongs95.portal.domain.classify;

/** The answer of a {@link ReaderGrammar}: it accepts the words, or it rejects them at one word (vendor {@code {ok: true}} or {@code {ok: false, word}}). */
record GrammarMatch(boolean accepted, String word) {

    static final GrammarMatch ACCEPTED = new GrammarMatch(true, "");

    static GrammarMatch rejectedAt(String word) {
        return new GrammarMatch(false, word);
    }
}
