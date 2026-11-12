package io.github.jaeseongs95.portal.app.output;

import java.util.Map;

/** The renderings of a finished output by format; both formats are present for a ready output. */
public record OutputFormats(Map<OutputFormat, FormatSpan> spans) {

    public OutputFormats {
        spans = Map.copyOf(spans);
    }
}
