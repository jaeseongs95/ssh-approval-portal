package io.github.jaeseongs95.portal.domain.classify;

import java.util.List;

/**
 * One command of a line: its words and the separator that opened it ({@code ;}, {@code &}, {@code |}, a line feed, or the empty string for the first segment).
 * When separators follow each other ({@code ||}), the empty segment between them is dropped and the separator is the last one (CL-T03).
 */
record Segment(List<String> words, String separator) {

    Segment {
        words = List.copyOf(words);
    }

    boolean followsPipe() {
        return "|".equals(separator);
    }
}
